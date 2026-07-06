// POST /api/admin/schools/{schoolId}/payments/invoices/bulk
//
// Create the SAME invoice (title + line items + due date) for many
// families at once — e.g. "bill every Lower El family the $35 field
// trip fee".
//
// Granularity (form field `granularity`):
//   family  (default) → ONE invoice per family, even with three
//                       matching students
//   student           → one invoice per matching active student, each
//                       stamped with that student_id (schools that run
//                       their books by the student record)
//
// Audience (form fields audience_type / audience_value / family_ids):
//   all              → every family with ≥1 active student
//   program:<value>  → families with an active student in that
//                      program OR homeroom (one dropdown serves both)
//   tag:<value>      → families where any parent's GHL contact carries
//                      that tag (synced ghl_contact_tags)
//   pick             → exactly the families checked in the picker
//                      (family_ids checkboxes)
//
// Auto-discount policies are intentionally NOT applied to bulk
// invoices — bulk is for flat fees; per-family discount math belongs
// to tuition plans and single invoices.
//
// send_now=1 → invoices open + email/GHL-workflow fires per family.
// Otherwise drafts (review, then send individually or go bulk again).

import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query, withTransaction } from '@/lib/db';
import { authorizeOperatorOrSchool } from '@/lib/auth/dual';
import { sendInvoiceEmail } from '@/lib/billing/send-invoice-email';
import { scheduleOneoffAutopay } from '@/lib/billing/oneoff-autopay';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

type Params = Promise<{ schoolId: string }>;

function safeReturn(returnTo: string | null, fallback: string): string {
  if (returnTo && /^\/(admin|school)\/[A-Za-z0-9_-]+(\/[^?#]*)?(\?[^#]*)?$/.test(returnTo)) return returnTo;
  return fallback;
}
function back(request: NextRequest, schoolId: string, q: { msg?: string; err?: string }, returnTo: string | null) {
  const url = request.nextUrl.clone();
  const target = safeReturn(returnTo, `/admin/${schoolId}/payments`);
  const [path, qs] = target.split('?');
  url.pathname = path;
  url.search = qs ? `?${qs}` : '';
  if (q.msg) url.searchParams.set('msg', q.msg);
  if (q.err) url.searchParams.set('err', q.err);
  return NextResponse.redirect(url, 303);
}
function dollarsToCents(raw: string): number {
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId } = await params;
  const _auth = await authorizeOperatorOrSchool(schoolId);
  if (!_auth.ok) return _auth.response;
  const fd = await request.formData();
  const returnTo = String(fd.get('return_to') ?? '').trim() || null;

  const audienceType = String(fd.get('audience_type') ?? 'all').trim();
  // The program/homeroom select and the tag select are separate form
  // fields (two selects can't share a name); read the one that matches
  // the chosen audience type.
  const audienceValue = audienceType === 'tag'
    ? String(fd.get('audience_value_tag') ?? '').trim()
    : String(fd.get('audience_value') ?? '').trim();
  const title = String(fd.get('title') ?? '').trim();
  const description = String(fd.get('description') ?? '').trim() || null;
  const dueDate = String(fd.get('due_date') ?? '').trim();
  const sendNow = fd.get('send_now') === '1';
  const perStudent = String(fd.get('granularity') ?? 'family').trim() === 'student';

  if (!title) return back(request, schoolId, { err: 'Title is required.' }, returnTo);
  if (!dueDate) return back(request, schoolId, { err: 'Due date is required.' }, returnTo);

  const lines: Array<{ description: string; quantity: number; unit_amount_cents: number; amount_cents: number; category: string | null }> = [];
  for (let i = 0; i < 50; i++) {
    const d = String(fd.get(`line_description_${i}`) ?? '').trim();
    const qn = parseInt(String(fd.get(`line_quantity_${i}`) ?? '0'), 10);
    const u = dollarsToCents(String(fd.get(`line_unit_amount_${i}`) ?? '0'));
    const cat = String(fd.get(`line_category_${i}`) ?? '').trim().toLowerCase();
    if (!d || !qn || u <= 0) continue;
    lines.push({ description: d, quantity: qn, unit_amount_cents: u, amount_cents: qn * u, category: cat || null });
  }
  if (lines.length === 0) return back(request, schoolId, { err: 'Add at least one line item.' }, returnTo);
  const subtotalCents = lines.reduce((a, l) => a + l.amount_cents, 0);

  // Resolve targets. Family mode → one row per family (student_id
  // null). Student mode → one row per matching active student; for
  // program/homeroom audiences only the MATCHING students are billed
  // (siblings outside the program are not).
  let targets: Array<{ family_id: string; student_id: string | null }>;
  if (audienceType === 'program' && audienceValue) {
    // The picker lists programs AND homerooms in one dropdown — match
    // the value against either so the operator never has to care which
    // kind it is.
    ({ rows: targets } = await query<{ family_id: string; student_id: string | null }>(
      perStudent
        ? `SELECT s.family_id, s.id AS student_id FROM students s JOIN families f ON f.id = s.family_id
            WHERE s.school_id = $1 AND s.status = 'active' AND f.status = 'active'
              AND (s.metadata->>'program' = $2 OR s.metadata->>'homeroom' = $2)
            ORDER BY s.first_name`
        : `SELECT DISTINCT s.family_id, NULL::uuid AS student_id FROM students s JOIN families f ON f.id = s.family_id
            WHERE s.school_id = $1 AND s.status = 'active' AND f.status = 'active'
              AND (s.metadata->>'program' = $2 OR s.metadata->>'homeroom' = $2)`,
      [schoolId, audienceValue],
    ));
  } else if (audienceType === 'homeroom' && audienceValue) {
    ({ rows: targets } = await query<{ family_id: string; student_id: string | null }>(
      perStudent
        ? `SELECT s.family_id, s.id AS student_id FROM students s JOIN families f ON f.id = s.family_id
            WHERE s.school_id = $1 AND s.status = 'active' AND f.status = 'active'
              AND s.metadata->>'homeroom' = $2
            ORDER BY s.first_name`
        : `SELECT DISTINCT s.family_id, NULL::uuid AS student_id FROM students s JOIN families f ON f.id = s.family_id
            WHERE s.school_id = $1 AND s.status = 'active' AND f.status = 'active'
              AND s.metadata->>'homeroom' = $2`,
      [schoolId, audienceValue],
    ));
  } else if (audienceType === 'tag' && audienceValue) {
    // Families where ANY active parent's GHL contact carries the tag —
    // in student mode, every active student in those families.
    ({ rows: targets } = await query<{ family_id: string; student_id: string | null }>(
      perStudent
        ? `SELECT s.family_id, s.id AS student_id FROM students s
            WHERE s.school_id = $1 AND s.status = 'active' AND s.family_id IN (
              SELECT DISTINCT p.family_id
                FROM ghl_contact_tags t
                JOIN parents p ON p.ghl_contact_id = t.ghl_contact_id AND p.school_id = t.school_id
                JOIN families f ON f.id = p.family_id
               WHERE t.school_id = $1 AND lower(t.tag) = lower($2)
                 AND p.status = 'active' AND f.status = 'active')
            ORDER BY s.first_name`
        : `SELECT DISTINCT p.family_id, NULL::uuid AS student_id
             FROM ghl_contact_tags t
             JOIN parents p ON p.ghl_contact_id = t.ghl_contact_id AND p.school_id = t.school_id
             JOIN families f ON f.id = p.family_id
            WHERE t.school_id = $1 AND lower(t.tag) = lower($2)
              AND p.status = 'active' AND f.status = 'active'`,
      [schoolId, audienceValue],
    ));
  } else if (audienceType === 'pick') {
    // Hand-picked checkboxes — validate every id belongs to this school
    // and is an active family.
    const picked = fd.getAll('family_ids').map(String).filter((s) => /^[0-9a-f-]{36}$/i.test(s)).slice(0, 1000);
    if (picked.length === 0) {
      return back(request, schoolId, { err: 'Check at least one family in the picker.' }, returnTo);
    }
    ({ rows: targets } = await query<{ family_id: string; student_id: string | null }>(
      perStudent
        ? `SELECT s.family_id, s.id AS student_id FROM students s
            WHERE s.school_id = $1 AND s.status = 'active' AND s.family_id IN (
              SELECT id FROM families WHERE school_id = $1 AND status = 'active' AND id = ANY($2::uuid[]))
            ORDER BY s.first_name`
        : `SELECT id AS family_id, NULL::uuid AS student_id FROM families
            WHERE school_id = $1 AND status = 'active' AND id = ANY($2::uuid[])`,
      [schoolId, picked],
    ));
  } else {
    ({ rows: targets } = await query<{ family_id: string; student_id: string | null }>(
      perStudent
        ? `SELECT s.family_id, s.id AS student_id FROM students s JOIN families f ON f.id = s.family_id
            WHERE s.school_id = $1 AND s.status = 'active' AND f.status = 'active'
            ORDER BY s.first_name`
        : `SELECT DISTINCT s.family_id, NULL::uuid AS student_id FROM students s JOIN families f ON f.id = s.family_id
            WHERE s.school_id = $1 AND s.status = 'active' AND f.status = 'active'`,
      [schoolId],
    ));
  }
  if (targets.length === 0) {
    return back(request, schoolId, { err: perStudent ? 'No students match that audience.' : 'No families match that audience.' }, returnTo);
  }

  const dueAtIso = new Date(dueDate + 'T23:59:59Z').toISOString();
  const issuedAt = sendNow ? new Date().toISOString() : null;
  const createdIds: string[] = [];

  // One-off autopay window (school policy) — read once for the whole batch.
  const { rows: oneoffCfg } = await query<{ days: number | null }>(
    `SELECT autopay_oneoff_after_days AS days FROM school_payment_config WHERE school_id = $1`,
    [schoolId],
  );
  const oneoffAfterDays = oneoffCfg[0]?.days ?? null;

  try {
    for (const target of targets) {
      // Per-invoice number (atomic bump, same scheme as single create).
      const { rows: cfgRows } = await query<{ prefix: string; next: number }>(
        `INSERT INTO school_payment_config (school_id) VALUES ($1)
         ON CONFLICT (school_id) DO UPDATE SET next_invoice_number = school_payment_config.next_invoice_number + 1
         RETURNING invoice_number_prefix AS prefix, next_invoice_number AS next`,
        [schoolId],
      );
      const seq = cfgRows[0].next > 1 ? cfgRows[0].next - 1 : 1;
      const invoiceNumber = `${cfgRows[0].prefix}-${String(seq).padStart(6, '0')}`;
      const token = randomBytes(18).toString('hex');

      const invoiceId = await withTransaction(async (q) => {
        const ins = await q<{ id: string }>(
          `INSERT INTO invoices
             (school_id, family_id, student_id, invoice_number, title, description, status,
              subtotal_cents, platform_fee_cents, discount_total_cents, total_cents,
              due_at, issued_at, source, includes_platform_setup_fee,
              created_by_email, public_pay_token)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,0,$8,$9,$10,'bulk',false,'operator@growthsuite.local',$11)
           RETURNING id`,
          [schoolId, target.family_id, target.student_id, invoiceNumber, title, description,
           sendNow ? 'open' : 'draft', subtotalCents, dueAtIso, issuedAt, token],
        );
        const id = ins.rows[0].id;
        let pos = 0;
        for (const l of lines) {
          await q(
            `INSERT INTO invoice_line_items
               (invoice_id, position, description, quantity, unit_amount_cents, amount_cents, category)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [id, pos++, l.description, l.quantity, l.unit_amount_cents, l.amount_cents, l.category],
          );
        }
        // Auto-bill this family's one-off charge N days out (if a card is on
        // file + the school enabled it). Cron does the charge once live.
        if (sendNow) {
          await scheduleOneoffAutopay(q, {
            schoolId, familyId: target.family_id, invoiceId: id,
            totalCents: subtotalCents, afterDays: oneoffAfterDays,
          });
        }
        return id;
      });
      createdIds.push(invoiceId);
    }

    // Delivery — best-effort per invoice; failures don't abort the batch.
    let emailed = 0;
    if (sendNow) {
      for (const id of createdIds) {
        try {
          const r = await sendInvoiceEmail({ invoiceId: id });
          if (r.ghl_notified || r.sent_to.length > 0) emailed++;
        } catch { /* per-invoice best-effort */ }
      }
    }

    const unit = perStudent ? 'per-student invoices' : 'invoices';
    const msg = sendNow
      ? `Bulk invoice sent: ${createdIds.length} ${unit} created, ${emailed} delivered (${(subtotalCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} each).`
      : `Bulk invoice: ${createdIds.length} DRAFT ${unit} created (${(subtotalCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} each). Review them in the Invoices tab, then send.`;
    return back(request, schoolId, { msg }, returnTo);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return back(request, schoolId, { err: `Bulk invoicing failed after ${createdIds.length} invoices: ${m}` }, returnTo);
  }
}
