// Enrolled-family sync — keeps a FROZEN (attributes_only) family graph current
// without ever rebuilding it. Runs from the sync-all cron right after the
// attribute layer refreshes the GHL cache, for schools with
// settings.auto_create_enrolled_families.
//
// Each run: rebuild every contact that holds an open Enrolled card from the
// attribute cache (ghl_contacts + custom-field values + tags — no extra GHL
// reads beyond the field schema), map it with the full sync's own mapper,
// plan additions with the pure planner (enrolled-family-plan.ts), and apply
// them in ONE transaction under the same per-school advisory lock the full
// sync takes, with the roster read inside the lock — so overlapping cron
// ticks can never double-create. Items it can't resolve safely are recorded
// in sync_attention and emailed; they clear themselves once the source data
// is fixed and the next run succeeds.

import { withTransaction, query } from '@/lib/db';
import { loadGhlClient } from '@/lib/ghl/client';
import type { GhlContact } from '@/lib/ghl/contacts';
import { loadSchoolSettings } from '@/lib/school-settings';
import { loadSchoolFieldSchema } from './schema-loader';
import { pipelineStageToFunnelStatus } from './pipeline-stage-map';
import {
  fetchFieldSchema,
  mapContactToFamily,
  insertOneFamily,
  insertStudentRow,
  type FieldSchema,
  type MappedFamily,
} from './run-ghl-sync';
import {
  planEnrolledFamilySync,
  isEnrolledCard,
  type Card,
  type CandidateContact,
  type Plan,
  type RosterParent,
  type RosterStudent,
} from './enrolled-family-plan';

// The application form's "add a second parent?" answer. When it's Yes but the
// family ends up with one parent, the office is told which fields to fill.
const WANTS_SECOND_PARENT_FIELD = 'would_you_like_to_add_an_additional_parentguardian';
const ATTENTION_PREFIX = 'efs:';
const REALERT_HOURS = 24;

export interface EnrolledSyncResult {
  ran: boolean;
  reason?: string;
  dry_run: boolean;
  enrolled_cards: number;
  families_created: number;
  students_added: number;
  parents_added: number;
  emails_filled: number;
  enrollments_upgraded: number;
  unchanged: number;
  attention: Array<{ key: string; message: string }>;
  details: string[];
  plan?: Plan;
}

interface CardRow { id: string; ghl_contact_id: string; name: string | null; stage_name: string | null; status: string | null }

export async function syncEnrolledFamilies(
  schoolId: string,
  opts: { dryRun?: boolean; force?: boolean } = {},
): Promise<EnrolledSyncResult> {
  const dryRun = opts.dryRun === true;
  const empty = (reason: string): EnrolledSyncResult => ({
    ran: false, reason, dry_run: dryRun, enrolled_cards: 0, families_created: 0, students_added: 0,
    parents_added: 0, emails_filled: 0, enrollments_upgraded: 0, unchanged: 0, attention: [], details: [],
  });

  const settings = await loadSchoolSettings(schoolId);
  if (!settings.auto_create_enrolled_families && !opts.force) return empty('not_enabled');

  // ---- cards (from the attribute cache, refreshed this tick) ----
  const { rows: cardRows } = await query<CardRow>(
    `SELECT id, ghl_contact_id, name, stage_name, status
       FROM ghl_opportunities WHERE school_id = $1 AND ghl_contact_id IS NOT NULL`,
    [schoolId],
  );
  const cardsByContact = new Map<string, Card[]>();
  for (const r of cardRows) {
    const card: Card = { id: r.id, name: r.name ?? '', funnel: pipelineStageToFunnelStatus(r.stage_name ?? ''), status: r.status };
    (cardsByContact.get(r.ghl_contact_id) ?? cardsByContact.set(r.ghl_contact_id, []).get(r.ghl_contact_id)!).push(card);
  }
  const enrolledCards = [...cardsByContact.values()].flat().filter(isEnrolledCard);
  if (enrolledCards.length === 0) return { ...empty('no_enrolled_cards'), ran: true };
  // Card names are what tell siblings apart. A cache written before card
  // names were stored would make every card look unmatched — wait a tick.
  if (enrolledCards.some((k) => !k.name.trim())) return empty('card_names_not_cached_yet');

  const candidateIds = [...cardsByContact.entries()]
    .filter(([, cards]) => cards.some(isEnrolledCard))
    .map(([id]) => id);

  // Families reached through a candidate contact whose PRIMARY is a
  // different contact: a new sibling's data lives on that primary record.
  const { rows: linkRows } = await query<{ family_id: string; contact_id: string; primary_contact: string | null }>(
    `SELECT p.family_id, p.ghl_contact_id AS contact_id,
            (SELECT pp.ghl_contact_id FROM parents pp
              WHERE pp.family_id = p.family_id AND pp.is_primary = true AND pp.status = 'active' LIMIT 1) AS primary_contact
       FROM parents p
      WHERE p.school_id = $1 AND p.status = 'active' AND p.ghl_contact_id = ANY($2::text[])`,
    [schoolId, candidateIds],
  );
  const primaryByFamily = new Map<string, string>();
  for (const r of linkRows) {
    if (r.primary_contact && r.primary_contact !== r.contact_id) primaryByFamily.set(r.family_id, r.primary_contact);
  }

  // ---- rebuild those contacts from cache, then map them ----
  const client = await loadGhlClient(schoolId);
  const schema = await fetchFieldSchema(client);
  const config = await loadSchoolFieldSchema(schoolId);
  const loadIds = [...new Set([...candidateIds, ...primaryByFamily.values()])];
  const contacts = await loadCachedContacts(schoolId, loadIds, schema);
  const mapOne = (id: string): MappedFamily | null => {
    const c = contacts.get(id);
    return c ? mapContactToFamily(c.contact, schema, config, [], { requireHousehold: false, forceEnrolled: true }) : null;
  };

  const candidates: CandidateContact[] = candidateIds.map((id) => {
    const c = contacts.get(id);
    return {
      contactId: id,
      contactName: c ? `${c.contact.firstName ?? ''} ${c.contact.lastName ?? ''}`.trim() || id : id,
      mapped: mapOne(id),
      cards: cardsByContact.get(id) ?? [],
      wantsSecondParent: (c?.raw.get(WANTS_SECOND_PARENT_FIELD) ?? '').trim().toLowerCase() === 'yes',
    };
  });
  const primaryMappedByFamily = new Map<string, MappedFamily>();
  for (const [familyId, contactId] of primaryByFamily) {
    const m = mapOne(contactId);
    if (m) primaryMappedByFamily.set(familyId, m);
  }

  const { rows: schoolRows } = await query<{ name: string }>(`SELECT name FROM schools WHERE id = $1`, [schoolId]);
  const schoolName = schoolRows[0]?.name ?? 'School';

  // ---- plan + apply under the per-school lock ----
  const outcome = await withTransaction(async (q) => {
    const { rows: lockRows } = await q<{ locked: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked`, [schoolId]);
    if (!lockRows[0]?.locked) return { skipped: true as const };

    // Roster read INSIDE the lock, so the plan reflects everything a previous
    // tick committed and nothing can be created twice.
    const { rows: parentRows } = await q<{
      id: string; family_id: string; ghl_contact_id: string | null; email: string | null;
      first_name: string | null; last_name: string | null; is_primary: boolean;
    }>(
      `SELECT id, family_id, ghl_contact_id, email, first_name, last_name, is_primary
         FROM parents WHERE school_id = $1 AND status = 'active'`,
      [schoolId],
    );
    const { rows: studentRows } = await q<{
      id: string; family_id: string; first_name: string | null; last_name: string | null;
      preferred_name: string | null; dob: string | null; enrollment_id: string | null; enrollment_status: string | null;
    }>(
      `SELECT s.id, s.family_id, s.first_name, s.last_name, s.preferred_name,
              s.date_of_birth::text AS dob, e.id AS enrollment_id, e.status AS enrollment_status
         FROM students s
         LEFT JOIN LATERAL (
           SELECT id, status FROM enrollments WHERE student_id = s.id
            ORDER BY created_at DESC LIMIT 1
         ) e ON true
        WHERE s.school_id = $1 AND s.status = 'active'`,
      [schoolId],
    );
    const { rows: famRows } = await q<{ id: string; display_name: string | null }>(
      `SELECT id, display_name FROM families WHERE school_id = $1`, [schoolId]);

    const parents: RosterParent[] = parentRows.map((p) => ({
      id: p.id, familyId: p.family_id, contactId: p.ghl_contact_id, email: p.email,
      firstName: p.first_name ?? '', lastName: p.last_name ?? '', isPrimary: p.is_primary,
    }));
    const students: RosterStudent[] = studentRows.map((s) => ({
      id: s.id, familyId: s.family_id, firstName: s.first_name ?? '', lastName: s.last_name ?? '',
      preferredName: s.preferred_name, dob: s.dob, enrollmentId: s.enrollment_id, enrollmentStatus: s.enrollment_status,
    }));
    const familyNames = new Map(famRows.map((f) => [f.id, (f.display_name ?? 'a family').replace(/\s*\(prospective\)\s*$/i, '')]));

    const plan = planEnrolledFamilySync({ candidates, primaryMappedByFamily, familyNames, parents, students });
    if (dryRun) return { skipped: false as const, plan, details: [] as string[] };

    const details: string[] = [];
    const warnings: string[] = [];
    const refToFamily = new Map<string, string>();
    const resolve = (ref: string) => (ref.startsWith('new:') ? refToFamily.get(ref) : ref);

    for (const c of plan.createFamilies) {
      const r = await insertOneFamily(q, schoolId, c.family);
      refToFamily.set(c.ref, r.familyId);
      details.push(`created ${c.family.display_name} — ${c.family.students.map((s) => `${s.first_name} ${s.last_name}`).join(', ')} (${c.family.parents.length} parent${c.family.parents.length === 1 ? '' : 's'})`);
    }
    for (const a of plan.addStudents) {
      const familyId = resolve(a.familyRef);
      if (!familyId) continue;
      await insertStudentRow(q, schoolId, familyId, a.student, warnings);
      details.push(`added ${a.student.first_name} ${a.student.last_name} to ${familyNames.get(familyId) ?? 'a new family'}`);
    }
    for (const a of plan.addParents) {
      const familyId = resolve(a.familyRef);
      if (!familyId) continue;
      await q(
        `INSERT INTO parents (family_id, school_id, ghl_contact_id, first_name, last_name, email, phone, role, is_primary, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, 'active')`,
        [familyId, schoolId, a.parent.ghl_contact_id, a.parent.first_name, a.parent.last_name,
         a.parent.email, a.parent.phone, a.parent.role],
      );
      details.push(`added co-parent ${a.parent.first_name} ${a.parent.last_name} <${a.parent.email}> to ${familyNames.get(familyId) ?? 'a new family'}`);
    }
    for (const f of plan.fillParentEmails) {
      // Fill a BLANK only — never replaces a login email.
      const r = await q(
        `UPDATE parents SET email = $2, updated_at = now()
          WHERE id = $1 AND (email IS NULL OR btrim(email) = '')`,
        [f.parentId, f.email],
      );
      if (r.rowCount) details.push(`filled email for ${f.name} <${f.email}>`);
    }
    for (const u of plan.upgradeEnrollments) {
      if (u.enrollmentId) {
        await q(`UPDATE enrollments SET status = 'enrolled', updated_at = now() WHERE id = $1 AND status <> 'enrolled'`, [u.enrollmentId]);
      } else {
        await q(
          `INSERT INTO enrollments (student_id, school_id, academic_year, status) VALUES ($1, $2, $3, 'enrolled')`,
          [u.studentId, schoolId, config.default_academic_year],
        );
      }
      details.push(`${u.name}: ${u.from ?? 'no enrollment'} → enrolled`);
    }
    return { skipped: false as const, plan, details };
  });

  if (outcome.skipped) return empty('locked_by_another_sync');
  const { plan, details } = outcome;

  const result: EnrolledSyncResult = {
    ran: true,
    dry_run: dryRun,
    enrolled_cards: enrolledCards.length,
    families_created: plan.createFamilies.length,
    students_added: plan.addStudents.length,
    parents_added: plan.addParents.length,
    emails_filled: plan.fillParentEmails.length,
    enrollments_upgraded: plan.upgradeEnrollments.length,
    unchanged: plan.unchanged,
    attention: plan.attention,
    details,
    ...(dryRun ? { plan } : {}),
  };
  if (!dryRun) await recordAttentionAndNotify(schoolId, schoolName, plan, details);
  return result;
}

// ---- cache → GhlContact ------------------------------------------------------

async function loadCachedContacts(
  schoolId: string,
  ids: string[],
  schema: FieldSchema,
): Promise<Map<string, { contact: GhlContact; raw: Map<string, string> }>> {
  const out = new Map<string, { contact: GhlContact; raw: Map<string, string> }>();
  if (ids.length === 0) return out;
  const { rows: base } = await query<{ ghl_contact_id: string; first_name: string | null; last_name: string | null; email: string | null; phone: string | null }>(
    `SELECT ghl_contact_id, first_name, last_name, email, phone
       FROM ghl_contacts WHERE school_id = $1 AND ghl_contact_id = ANY($2::text[])`,
    [schoolId, ids],
  );
  const { rows: tags } = await query<{ ghl_contact_id: string; tag: string }>(
    `SELECT ghl_contact_id, tag FROM ghl_contact_tags WHERE school_id = $1 AND ghl_contact_id = ANY($2::text[])`,
    [schoolId, ids],
  );
  const { rows: fields } = await query<{ ghl_contact_id: string; field_key: string; value: string | null }>(
    `SELECT ghl_contact_id, field_key, value FROM ghl_contact_field_values
      WHERE school_id = $1 AND ghl_contact_id = ANY($2::text[])`,
    [schoolId, ids],
  );
  for (const b of base) {
    out.set(b.ghl_contact_id, {
      contact: {
        id: b.ghl_contact_id,
        firstName: b.first_name ?? undefined,
        lastName: b.last_name ?? undefined,
        email: b.email,
        phone: b.phone,
        tags: [],
        customFields: [],
      },
      raw: new Map(),
    });
  }
  for (const t of tags) out.get(t.ghl_contact_id)?.contact.tags!.push(t.tag);
  for (const f of fields) {
    const entry = out.get(f.ghl_contact_id);
    if (!entry || f.value == null) continue;
    entry.raw.set(f.field_key, f.value);
    const id = schema.get(f.field_key);
    if (id) entry.contact.customFields!.push({ id, value: f.value });
  }
  return out;
}

// ---- attention bookkeeping + email --------------------------------------------

async function recordAttentionAndNotify(
  schoolId: string,
  schoolName: string,
  plan: Plan,
  details: string[],
): Promise<void> {
  const keys = plan.attention.map((a) => ATTENTION_PREFIX + a.key);
  for (const a of plan.attention) {
    await query(
      `INSERT INTO sync_attention (school_id, item_key, message)
       VALUES ($1, $2, $3)
       ON CONFLICT (school_id, item_key) DO UPDATE
         SET message = EXCLUDED.message, last_seen_at = now(),
             resolved_at = NULL,
             last_alerted_at = CASE WHEN sync_attention.resolved_at IS NOT NULL THEN NULL ELSE sync_attention.last_alerted_at END`,
      [schoolId, ATTENTION_PREFIX + a.key, a.message],
    );
  }
  // Anything this sync raised before and no longer sees has been fixed.
  await query(
    `UPDATE sync_attention SET resolved_at = now()
      WHERE school_id = $1 AND resolved_at IS NULL AND item_key LIKE $2
        AND NOT (item_key = ANY($3::text[]))`,
    [schoolId, ATTENTION_PREFIX + '%', keys],
  );

  const { rows: due } = await query<{ item_key: string; message: string }>(
    `SELECT item_key, message FROM sync_attention
      WHERE school_id = $1 AND resolved_at IS NULL AND item_key LIKE $2
        AND (last_alerted_at IS NULL OR last_alerted_at < now() - ($3 || ' hours')::interval)
      ORDER BY first_seen_at`,
    [schoolId, ATTENTION_PREFIX + '%', String(REALERT_HOURS)],
  );
  if (due.length === 0 && details.length === 0) return;

  const alertTo = process.env.SYNC_ALERT_EMAIL || 'clint@getaims.co';
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const subject = due.length > 0
    ? `${schoolName}: ${due.length} enrollment record${due.length === 1 ? '' : 's'} need attention`
    : `${schoolName}: portal updated automatically (${details.length} change${details.length === 1 ? '' : 's'})`;
  const doneText = details.length ? `Added to the parent portal automatically:\n${details.map((d) => `  • ${d}`).join('\n')}\n\n` : '';
  const dueText = due.length ? `Needs a person (the sync won't guess):\n${due.map((d) => `  • ${d.message}`).join('\n')}\n\nEach item clears itself on the next sync once the record is fixed in Growth Suite.\n` : '';
  try {
    const { sendBrandedEmail } = await import('@/lib/email');
    await sendBrandedEmail({
      to: alertTo,
      schoolId: null,
      subject,
      text: doneText + dueText,
      html: (details.length ? `<p><strong>Added to the parent portal automatically:</strong></p><ul>${details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : '')
        + (due.length ? `<p><strong>Needs a person</strong> (the sync won't guess):</p><ul>${due.map((d) => `<li>${esc(d.message)}</li>`).join('')}</ul><p>Each item clears itself on the next sync once the record is fixed in Growth Suite.</p>` : ''),
    });
    if (due.length > 0) {
      await query(
        `UPDATE sync_attention SET last_alerted_at = now() WHERE school_id = $1 AND item_key = ANY($2::text[])`,
        [schoolId, due.map((d) => d.item_key)],
      );
    }
  } catch (e) {
    // Alerting must never fail the sync; the item stays due and re-sends next tick.
    console.warn('[enrolled-family-sync] alert email failed:', e instanceof Error ? e.message : String(e));
  }
}
