// One-shot migration: promote each family's Parent 2 into a standalone
// GHL contact and link them to Parent 1 via the GHL Associations API.
//
// Idempotent. Safe to re-run. Per family:
//   - Skip if Parent 2 row doesn't exist (single-parent family) or has no email
//   - Skip if Parent 2 row already has ghl_contact_id (already promoted)
//   - Skip if Parent 1 doesn't have a ghl_contact_id (can't link to anything)
//   - Otherwise:
//       1. Upsert by email → returns existing P2 contact if one was made
//          manually, else creates a new one
//       2. Link P1 ↔ P2 via "co_parent" GHL Association
//       3. Update family-graph parents row with the new ghl_contact_id
//       4. Insert family_relationships row with the GHL association/relation ids
//
// Returns a result summary per family for the operator UI.

import { query } from '@/lib/db';
import { loadGhlClient, type GhlClient } from '@/lib/ghl/client';
import { upsertContactByEmail } from '@/lib/ghl/contacts';
import { linkContacts } from '@/lib/ghl/associations';

// Schools where the promote-parent2 pass runs automatically (on the sync cron).
// Other schools can still trigger it on demand from the admin UI.
export const PROMOTE_PARENT2_SCHOOLS = new Set<string>([
  '005c2872-dd27-4c43-9b3c-5fd353b8db44', // Desert Garden Montessori 2.0
]);

// Email-marketing tags applied to each parent contact during promotion.
const P1_TAGS = ['Parent 1', 'Parent'];
const P2_TAGS = ['Parent 2', 'Parent'];

// Append tags to a GHL contact (does NOT clobber existing tags).
async function addContactTags(client: GhlClient, contactId: string, tags: string[]): Promise<void> {
  await client.axios.post(`/contacts/${contactId}/tags`, { tags });
}

export interface PromoteResult {
  total_families: number;
  already_promoted: number;
  promoted_now: number;
  skipped_no_p2: number;
  skipped_no_p2_email: number;
  skipped_no_p1_contact: number;
  errors: number;
  details: Array<{
    family_id: string;
    family_display_name: string;
    status: 'promoted' | 'already' | 'skipped_no_p2' | 'skipped_no_p2_email' | 'skipped_no_p1_contact' | 'error';
    p2_contact_id?: string;
    p2_email?: string;
    p1_email?: string;
    note?: string;
    error?: string;
  }>;
}

interface FamilyParents {
  family_id: string;
  family_display_name: string | null;
  p1_parent_id: string | null;
  p1_ghl_contact_id: string | null;
  p1_first_name: string | null;
  p1_last_name: string | null;
  p1_email: string | null;
  p1_phone: string | null;
  p2_parent_id: string | null;
  p2_ghl_contact_id: string | null;
  p2_first_name: string | null;
  p2_last_name: string | null;
  p2_email: string | null;
  p2_phone: string | null;
  students: Array<{ slot: number; first: string | null; last: string | null }>;
}

export async function promoteParent2sForSchool(
  schoolId: string,
  opts?: { dryRun?: boolean; familyIds?: string[] },
): Promise<PromoteResult> {
  // Gather one row per family with both parents laterally joined.
  const familyFilter = opts?.familyIds?.length
    ? `AND f.id = ANY($2::uuid[])`
    : '';
  const params: unknown[] = opts?.familyIds?.length ? [schoolId, opts.familyIds] : [schoolId];

  const { rows: families } = await query<FamilyParents>(
    `SELECT
       f.id AS family_id,
       f.display_name AS family_display_name,
       p1.id AS p1_parent_id,
       p1.ghl_contact_id AS p1_ghl_contact_id,
       p1.first_name AS p1_first_name,
       p1.last_name AS p1_last_name,
       p1.email AS p1_email,
       p1.phone AS p1_phone,
       p2.id AS p2_parent_id,
       p2.ghl_contact_id AS p2_ghl_contact_id,
       p2.first_name AS p2_first_name,
       p2.last_name AS p2_last_name,
       p2.email AS p2_email,
       p2.phone AS p2_phone,
       COALESCE((
         SELECT json_agg(json_build_object(
                  'slot', COALESCE((s.metadata->>'ghl_slot')::int, 1),
                  'first', s.first_name, 'last', s.last_name)
                ORDER BY COALESCE((s.metadata->>'ghl_slot')::int, 1))
           FROM students s WHERE s.family_id = f.id AND s.status = 'active'
       ), '[]'::json) AS students
     FROM families f
     LEFT JOIN LATERAL (
       SELECT id, ghl_contact_id, first_name, last_name, email, phone FROM parents
       WHERE family_id = f.id AND is_primary = true AND status = 'active'
       ORDER BY created_at LIMIT 1
     ) p1 ON true
     LEFT JOIN LATERAL (
       SELECT id, ghl_contact_id, first_name, last_name, email, phone FROM parents
       WHERE family_id = f.id AND is_primary = false AND status = 'active'
       ORDER BY created_at LIMIT 1
     ) p2 ON true
     WHERE f.school_id = $1 ${familyFilter}
     ORDER BY f.display_name`,
    params,
  );

  const result: PromoteResult = {
    total_families: families.length,
    already_promoted: 0,
    promoted_now: 0,
    skipped_no_p2: 0,
    skipped_no_p2_email: 0,
    skipped_no_p1_contact: 0,
    errors: 0,
    details: [],
  };

  // Only need one GHL client per school
  const client = await loadGhlClient(schoolId);

  // Custom-field key → id map, so we can write family data (student names +
  // Parent 1 info) onto each promoted Parent 2 contact.
  const fieldMap = new Map<string, string>();
  try {
    const cfData = (await client.axios.get<{ customFields?: Array<{ id: string; fieldKey?: string }> }>(
      `/locations/${client.locationId}/customFields`)).data?.customFields ?? [];
    for (const f of cfData) if (f.fieldKey) fieldMap.set(f.fieldKey.replace(/^contact\./, ''), f.id);
  } catch { /* carry-over is skipped if we can't resolve field ids */ }

  for (const fam of families) {
    const famName = fam.family_display_name ?? `${fam.p1_last_name ?? '(unnamed)'} Family`;

    // No Parent 2 row at all — single-parent family
    if (!fam.p2_parent_id) {
      result.skipped_no_p2++;
      result.details.push({
        family_id: fam.family_id,
        family_display_name: famName,
        status: 'skipped_no_p2',
        p1_email: fam.p1_email ?? undefined,
      });
      continue;
    }

    // Already promoted
    if (fam.p2_ghl_contact_id) {
      result.already_promoted++;
      result.details.push({
        family_id: fam.family_id,
        family_display_name: famName,
        status: 'already',
        p2_contact_id: fam.p2_ghl_contact_id,
        p2_email: fam.p2_email ?? undefined,
      });
      continue;
    }

    // P2 has no email → can't dedupe by email AND probably can't reach them
    // via campaigns either. Skip and let operator decide whether to backfill
    // the email and re-run. (If we wanted to push harder we could create a
    // contact with phone-only, but GHL often requires email — punting.)
    if (!fam.p2_email) {
      result.skipped_no_p2_email++;
      result.details.push({
        family_id: fam.family_id,
        family_display_name: famName,
        status: 'skipped_no_p2_email',
        note: 'Parent 2 has no email — add one in GHL and re-run.',
      });
      continue;
    }

    // P1 has no GHL contact — can't create a relation pointing nowhere
    if (!fam.p1_ghl_contact_id) {
      result.skipped_no_p1_contact++;
      result.details.push({
        family_id: fam.family_id,
        family_display_name: famName,
        status: 'skipped_no_p1_contact',
        note: 'Primary parent has no GHL contact id — sync first.',
      });
      continue;
    }

    if (opts?.dryRun) {
      result.promoted_now++;
      result.details.push({
        family_id: fam.family_id,
        family_display_name: famName,
        status: 'promoted',
        p2_email: fam.p2_email,
        note: '(dry run — no changes made)',
      });
      continue;
    }

    try {
      // 1. Upsert P2 contact in GHL (will return existing if email matches)
      const { contact: p2, created } = await upsertContactByEmail(client, {
        firstName: fam.p2_first_name ?? '',
        lastName: fam.p2_last_name ?? fam.p1_last_name ?? '',
        email: fam.p2_email,
        phone: fam.p2_phone,
      });

      // Safety: if upsert returned P1's own contact (because someone set
      // parent_2_email = parent_1_email), bail out so we don't link a
      // contact to itself.
      if (p2.id === fam.p1_ghl_contact_id) {
        throw new Error(
          'Parent 2 email matches Parent 1 — refusing to create a self-link. Fix the email in GHL.',
        );
      }

      // 2. Link P1 ↔ P2 in GHL as co-parents
      const link = await linkContacts(client, {
        relationship: 'co_parent',
        label: 'Co-Parent',
        firstContactId: fam.p1_ghl_contact_id,
        secondContactId: p2.id,
      });

      // 3. Update P2's family-graph row with the contact id
      await query(
        `UPDATE parents SET ghl_contact_id = $1, updated_at = now() WHERE id = $2`,
        [p2.id, fam.p2_parent_id],
      );

      // 4. Audit row in family_relationships (best-effort — table may not
      // have a unique constraint, so use ON CONFLICT DO NOTHING when possible)
      await query(
        `INSERT INTO family_relationships
           (family_id, school_id, from_parent_id, to_parent_id, relationship, ghl_association_id)
         VALUES ($1, $2, $3, $4, 'co_parent', $5)
         ON CONFLICT DO NOTHING`,
        [fam.family_id, schoolId, fam.p1_parent_id, fam.p2_parent_id, link.relationId],
      ).catch(() => undefined);

      // #2 Tags (email-marketing segmentation) + #4 carry-over (mirror the
      // family onto P2's contact so it stands alone: student name(s) + Parent 1
      // in the co-parent parent_2_* slots). Best-effort — the promotion above
      // already succeeded, so don't fail it on a tag/field error. P2's contact
      // gets NO household_id, so the sync never treats it as a duplicate family.
      try {
        await addContactTags(client, fam.p1_ghl_contact_id, P1_TAGS);
        await addContactTags(client, p2.id, P2_TAGS);
        const cf: Array<{ id: string; field_value: string }> = [];
        const setField = (key: string, val: string | null | undefined) => {
          const id = fieldMap.get(key);
          if (id && val != null && String(val).trim() !== '') cf.push({ id, field_value: String(val) });
        };
        setField('parent_2_first_name', fam.p1_first_name);
        setField('parent_2_last_name', fam.p1_last_name);
        setField('parent_2_email', fam.p1_email);
        setField('parent_2_phone', fam.p1_phone);
        for (const s of fam.students ?? []) {
          setField(`student_${s.slot}_first_name`, s.first);
          setField(`student_${s.slot}_last_name`, s.last);
        }
        if (cf.length > 0) await client.axios.put(`/contacts/${p2.id}`, { customFields: cf });
      } catch (coErr) {
        console.warn(`[promote-p2] ${famName} tags/carry-over failed:`, coErr instanceof Error ? coErr.message : String(coErr));
      }

      result.promoted_now++;
      const noteParts: string[] = [];
      noteParts.push(created ? 'created new contact' : 'reused existing contact');
      if (link.alreadyLinked) noteParts.push('association already existed');
      result.details.push({
        family_id: fam.family_id,
        family_display_name: famName,
        status: 'promoted',
        p2_contact_id: p2.id,
        p2_email: fam.p2_email,
        note: noteParts.join('; '),
      });
    } catch (err) {
      // Surface axios response body when present — that's where GHL's
      // actual error text lives (e.g. "This location does not allow
      // duplicated contacts").
      let msg: string;
      if (err && typeof err === 'object' && 'response' in err) {
        const e = err as { response?: { status?: number; data?: unknown }; message?: string };
        const body = e.response?.data;
        const summary = typeof body === 'string'
          ? body
          : body && typeof body === 'object' && 'message' in body
            ? String((body as { message: unknown }).message)
            : JSON.stringify(body ?? null);
        msg = `${e.message ?? 'request error'} (${e.response?.status}): ${summary}`;
      } else {
        msg = err instanceof Error ? err.message : String(err);
      }
      result.errors++;
      result.details.push({
        family_id: fam.family_id,
        family_display_name: famName,
        status: 'error',
        p2_email: fam.p2_email ?? undefined,
        error: msg,
      });
      console.error(`[promote-p2] ${famName} failed:`, msg);
    }
  }

  return result;
}
