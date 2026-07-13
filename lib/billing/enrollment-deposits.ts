// Enrollment-deposit invoicing — send the deposit the moment a student is
// accepted.
//
// When an admissions opportunity reaches an "accepted" stage (e.g. GHL stage
// "Offer Accepted"), the family owes an enrollment deposit: a full deposit for
// the first child and a reduced sibling deposit for each additional child. This
// module turns that into open invoices, idempotently.
//
//   generateEnrollmentDeposits(schoolId, familyId)
//     - creates ONE 'enrollment_deposit' invoice per student that doesn't have
//       one yet; the first deposit in the family is `first_cents`, every later
//       one is `additional_cents` — so the $400/$200 sibling split is correct
//       whether siblings are accepted together or weeks apart.
//     - idempotent: a student that already has a (non-voided) deposit invoice
//       is skipped, so re-firing the webhook or cron never double-charges.
//
//   generateDepositsForAcceptedFamilies(schoolId)
//     - cron safety net: finds accepted-stage opportunities (changed on/after
//       the feature's effective_from so rollout never back-bills), ensures the
//       family exists, then runs the per-family generator.
//
// Config lives on schools.settings.enrollment_deposit — nothing is created
// unless a school has explicitly turned it on:
//   { enabled, first_cents, additional_cents, due_days, autopay, effective_from }

import { query, withTransaction } from '@/lib/db';
import { createFamilyFromContact } from '@/lib/sync/create-family-from-contact';
import { pipelineStageToFunnelStatus } from '@/lib/sync/pipeline-stage-map';

export interface DepositConfig {
  enabled: boolean;
  first_cents: number;
  additional_cents: number;
  due_days: number;
  autopay: boolean;
  effective_from: string | null;
}

const DEFAULTS = { first_cents: 40000, additional_cents: 20000, due_days: 7 };

// Read + normalize a school's deposit config. Returns null when the feature
// isn't explicitly enabled, so every caller no-ops safely by default.
export async function readDepositConfig(schoolId: string): Promise<DepositConfig | null> {
  const { rows } = await query<{ dep: Partial<DepositConfig> | null }>(
    `SELECT settings->'enrollment_deposit' AS dep FROM schools WHERE id = $1`,
    [schoolId],
  );
  const raw = rows[0]?.dep;
  if (!raw || typeof raw !== 'object' || raw.enabled !== true) return null;
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    enabled: true,
    first_cents: num(raw.first_cents, DEFAULTS.first_cents),
    additional_cents: num(raw.additional_cents, DEFAULTS.additional_cents),
    due_days: num(raw.due_days, DEFAULTS.due_days),
    autopay: raw.autopay !== false,
    effective_from: typeof raw.effective_from === 'string' ? raw.effective_from : null,
  };
}

export interface DepositResult {
  family_id: string;
  created: Array<{ invoice_number: string; student: string; cents: number }>;
  skipped: number;
}

export async function generateEnrollmentDeposits(schoolId: string, familyId: string): Promise<DepositResult> {
  const out: DepositResult = { family_id: familyId, created: [], skipped: 0 };
  const cfg = await readDepositConfig(schoolId);
  if (!cfg) return out;

  // Family's active students, stable order (earliest created = "first child").
  const { rows: students } = await query<{ id: string; name: string }>(
    `SELECT id, CONCAT_WS(' ', COALESCE(NULLIF(preferred_name, ''), first_name), last_name) AS name
       FROM students
      WHERE school_id = $1 AND family_id = $2 AND status = 'active'
      ORDER BY created_at ASC, id ASC`,
    [schoolId, familyId],
  );
  if (students.length === 0) return out;

  // Students that already have a (non-voided) deposit invoice — for idempotency
  // AND to rank siblings correctly across staggered acceptances.
  const { rows: existing } = await query<{ student_id: string }>(
    `SELECT source_ref->>'student_id' AS student_id
       FROM invoices
      WHERE school_id = $1 AND family_id = $2 AND source = 'enrollment_deposit' AND status <> 'voided'`,
    [schoolId, familyId],
  );
  const alreadyHas = new Set(existing.map((r) => r.student_id).filter(Boolean));
  let rank = alreadyHas.size; // 0 → first deposit in the family gets first_cents

  // Attach the family's saved card so the deposit auto-charges on its due date;
  // if none is on file yet, leave it armed (the Stripe webhook attaches on
  // card-save, same as tuition). Only when autopay is enabled.
  const { rows: pm } = await query<{ pm: string | null }>(
    `SELECT autopay_payment_method_id AS pm FROM invoices
      WHERE school_id = $1 AND family_id = $2 AND autopay_payment_method_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`,
    [schoolId, familyId],
  );
  const methodId = cfg.autopay ? (pm[0]?.pm ?? null) : null;

  for (const st of students) {
    if (alreadyHas.has(st.id)) { out.skipped++; continue; }
    const isFirst = rank === 0;
    const cents = isFirst ? cfg.first_cents : cfg.additional_cents;
    rank++;
    const label = isFirst ? 'Enrollment deposit' : 'Enrollment deposit (sibling)';

    const invNum = await withTransaction(async (q) => {
      const c = await q<{ prefix: string; next: number }>(
        `INSERT INTO school_payment_config (school_id) VALUES ($1)
         ON CONFLICT (school_id) DO UPDATE SET next_invoice_number = school_payment_config.next_invoice_number + 1
         RETURNING invoice_number_prefix AS prefix, next_invoice_number AS next`,
        [schoolId],
      );
      const seq = c.rows[0].next > 1 ? c.rows[0].next - 1 : 1;
      const number = `${c.rows[0].prefix}-${String(seq).padStart(6, '0')}`;
      const inv = await q<{ id: string }>(
        `INSERT INTO invoices
           (school_id, family_id, student_id, invoice_number, title, description,
            status, subtotal_cents, platform_fee_cents, discount_total_cents, total_cents,
            due_at, issued_at, source, source_ref, includes_platform_setup_fee, created_by_email,
            autopay_enabled, autopay_payment_method_id)
         VALUES ($1,$2,$3,$4,$5,$6,'open',$7,0,0,$7,
                 (now() + make_interval(days => $8::int))::date, now(),
                 'enrollment_deposit', $9::jsonb, false, 'system@growthsuite.local', $10, $11)
         RETURNING id`,
        [schoolId, familyId, st.id, number, label, `Enrollment deposit — ${st.name}`,
          cents, cfg.due_days,
          JSON.stringify({ enrollment_deposit: true, student_id: st.id, family_id: familyId }),
          cfg.autopay, methodId],
      );
      await q(
        `INSERT INTO invoice_line_items
           (invoice_id, position, description, quantity, unit_amount_cents, amount_cents, category, student_id)
         VALUES ($1, 0, $2, 1, $3, $3, 'deposit', $4)`,
        [inv.rows[0].id, label, cents, st.id],
      );
      return number;
    });
    out.created.push({ invoice_number: invNum, student: st.name, cents });
  }
  return out;
}

export interface DepositSweepResult {
  ran: boolean;
  reason?: string;
  families: number;
  created: number;
  errors: number;
  details: string[];
}

// Cron safety net — idempotent, safe every tick. Only accepted-stage
// opportunities that changed on/after effective_from are processed, so turning
// the feature on never back-bills families accepted beforehand.
export async function generateDepositsForAcceptedFamilies(schoolId: string): Promise<DepositSweepResult> {
  const cfg = await readDepositConfig(schoolId);
  if (!cfg) return { ran: false, reason: 'disabled', families: 0, created: 0, errors: 0, details: [] };

  const { rows: opps } = await query<{ ghl_contact_id: string; stage_name: string | null }>(
    `SELECT DISTINCT o.ghl_contact_id, o.stage_name
       FROM ghl_opportunities o
      WHERE o.school_id = $1 AND o.ghl_contact_id IS NOT NULL
        AND ($2::timestamptz IS NULL OR o.last_stage_change_at >= $2::timestamptz)`,
    [schoolId, cfg.effective_from],
  );
  const acceptedContacts = opps
    .filter((o) => pipelineStageToFunnelStatus(o.stage_name ?? '') === 'accepted')
    .map((o) => o.ghl_contact_id);

  const out: DepositSweepResult = { ran: true, families: 0, created: 0, errors: 0, details: [] };
  for (const contactId of acceptedContacts) {
    try {
      const create = await createFamilyFromContact(schoolId, contactId);
      let familyId = create.family_id;
      if (!familyId) {
        const { rows } = await query<{ family_id: string }>(
          `SELECT family_id FROM parents WHERE school_id = $1 AND ghl_contact_id = $2 LIMIT 1`,
          [schoolId, contactId],
        );
        familyId = rows[0]?.family_id;
      }
      if (!familyId) { out.details.push(`skip ${contactId}: ${create.reason ?? 'no family'}`); continue; }
      const dep = await generateEnrollmentDeposits(schoolId, familyId);
      if (dep.created.length > 0) {
        out.families++;
        out.created += dep.created.length;
        out.details.push(`family ${familyId}: +${dep.created.length} deposit(s)`);
      }
    } catch (e) {
      out.errors++;
      out.details.push(`error ${contactId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}
