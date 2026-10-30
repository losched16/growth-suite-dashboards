// Applicant portal account — turn a GHL contact that has been INVITED TO APPLY
// into a loginable, parent-only family.
//
// Admissions schools (Nativity) run their application and document
// collection in the parent portal. When a contact reaches the school's "ready
// to apply" stage, the applicant-invite webhook calls this to make sure the
// contact has a parent row to log in with — before there is any student.
//
//   createApplicantFamily(schoolId, contactId)
//     - idempotent: a parent already linked to this GHL contact is reused
//     - reuses the sync's contact→family mapper, then DROPS every student: an
//       applicant is not enrolled, must never reach a roster / classroom hub /
//       attendance board, and their application answers live on the contact
//       and the submission, not in `students`
//     - keeps the second parent only when they have a usable, unclaimed email
//     - stamps parents.portal_invited_at on the whole family — the invitation
//       is the authorization to create a login (see the portal's
//       lib/auth/portal-provisioning.ts), so no pipeline-stage list is needed
//
// What it does NOT do: touch the GHL contact, create students or enrollments,
// or send anything. Emailing is the webhook's job.
//
// When the family later reaches Enrolled, the enrolled-family sync finds this
// family through the contact link and adds the student to it — same login.

import { withTransaction, query } from '@/lib/db';
import { loadGhlClient } from '@/lib/ghl/client';
import { getContact } from '@/lib/ghl/contacts';
import { loadSchoolFieldSchema } from './schema-loader';
import { fetchFieldSchema, mapContactToFamily, insertOneFamily } from './run-ghl-sync';

export interface ApplicantResult {
  ok: boolean;
  created: boolean;
  reason?: string;
  family_id?: string;
  parent_id?: string;
  parent_email?: string;
  parent_first_name?: string | null;
  has_password?: boolean;
}

const lc = (e: string | null | undefined) => (e ?? '').trim().toLowerCase();

export async function createApplicantFamily(schoolId: string, contactId: string): Promise<ApplicantResult> {
  if (!contactId) return { ok: false, created: false, reason: 'no_contact_id' };

  // Idempotency: a parent already linked to this contact means a portal
  // account exists (an applicant re-invited, or an existing family applying
  // for another child). Reuse it — and make sure the invite is stamped so the
  // gate lets them in.
  const { rows: existing } = await query<{
    id: string; family_id: string; email: string | null; first_name: string | null; password_set_at: string | null; is_primary: boolean;
  }>(
    `SELECT id, family_id, email, first_name, password_set_at, is_primary
       FROM parents
      WHERE school_id = $1 AND ghl_contact_id = $2 AND status = 'active'
      ORDER BY is_primary DESC, created_at ASC LIMIT 1`,
    [schoolId, contactId],
  );
  if (existing[0]) {
    const e = existing[0];
    await query(
      `UPDATE parents SET portal_invited_at = COALESCE(portal_invited_at, now())
        WHERE family_id = $1 AND school_id = $2 AND status = 'active'`,
      [e.family_id, schoolId],
    );
    if (!lc(e.email)) return { ok: false, created: false, reason: 'primary_parent_missing_email', family_id: e.family_id, parent_id: e.id };
    return {
      ok: true, created: false, reason: 'already_exists', family_id: e.family_id, parent_id: e.id,
      parent_email: e.email!.trim(), parent_first_name: e.first_name, has_password: !!e.password_set_at,
    };
  }

  const client = await loadGhlClient(schoolId);
  const contact = await getContact(client, contactId);
  if (!contact) return { ok: false, created: false, reason: 'contact_not_found' };

  const config = await loadSchoolFieldSchema(schoolId);
  const schema = await fetchFieldSchema(client);
  const fam = mapContactToFamily(contact, schema, config, [], { requireHousehold: false, forceEnrolled: true });
  if (!fam) return { ok: false, created: false, reason: 'could_not_map_contact' };

  // The primary parent MUST have an email — it is the login. Without one the
  // portal is useless, so surface the reason (the webhook tags the contact so
  // the office can see who to fix) instead of creating a dead account.
  const primary = fam.parents.find((p) => p.is_primary);
  if (!primary || !lc(primary.email)) return { ok: false, created: false, reason: 'primary_parent_missing_email' };

  // The login is the email, so one email can belong to only one family in a
  // school. If it already belongs to a parent on a different contact, stop and
  // let a person decide — never attach a stranger's login to this applicant.
  const { rows: clash } = await query<{ ghl_contact_id: string | null }>(
    `SELECT ghl_contact_id FROM parents
      WHERE school_id = $1 AND status = 'active' AND lower(btrim(email)) = $2 LIMIT 1`,
    [schoolId, lc(primary.email)],
  );
  if (clash[0]) return { ok: false, created: false, reason: 'email_belongs_to_another_family' };

  // Keep a second parent only if they can actually log in without colliding.
  const keep: typeof fam.parents = [primary];
  for (const p of fam.parents) {
    if (p === primary) continue;
    const em = lc(p.email);
    if (!em || em === lc(primary.email)) continue;
    const { rows: c2 } = await query(
      `SELECT 1 FROM parents WHERE school_id = $1 AND status = 'active' AND lower(btrim(email)) = $2 LIMIT 1`,
      [schoolId, em],
    );
    if (c2.length === 0) keep.push(p);
  }

  const applicantFamily = { ...fam, parents: keep, students: [] };
  const res = await withTransaction(async (q) => {
    const r = await insertOneFamily(q, schoolId, applicantFamily);
    await q(
      `UPDATE parents SET portal_invited_at = now() WHERE family_id = $1 AND school_id = $2`,
      [r.familyId, schoolId],
    );
    return r;
  });

  const { rows: pr } = await query<{ id: string }>(
    `SELECT id FROM parents WHERE school_id = $1 AND ghl_contact_id = $2 AND is_primary = true LIMIT 1`,
    [schoolId, contactId],
  );
  return {
    ok: true, created: true, family_id: res.familyId, parent_id: pr[0]?.id,
    parent_email: primary.email!.trim(), parent_first_name: primary.first_name, has_password: false,
  };
}
