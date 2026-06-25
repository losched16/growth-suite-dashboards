// GHL → dashboard propagation for per-student contact fields.
//
// The attribute sync mirrors every contact custom field into
// ghl_contact_field_values, but dashboard widgets (roster, finance,
// rosters hub…) read per-student data from students.metadata. For
// snapshot-mode schools the full sync rebuilds metadata; for
// attributes_only schools (roster managed by imports) nothing carried
// GHL field edits back into metadata — so a tuition edited on the GHL
// contact updated the Family Hub's contact-attr panel but left the
// roster's metadata-backed columns stale.
//
// This closes that gap: for every student that knows its slot on the
// family's parent contacts (metadata.ghl_slot, set by the roster
// import + writeback), copy the slot's field values
// (student_<base> for slot 1, student_<2-4>_<base> for the rest)
// into students.metadata. GHL is the source of truth: any non-empty
// synced value that differs overwrites the metadata key.
//
// Deliberately NOT propagated:
//   - identity fields that live as real columns (first/last name,
//     DOB, gender, preferred name) — column sync is the contact
//     webhook's job and silently diverging metadata copies would
//     confuse no one productively
//   - deletions: a field absent from the sync is indistinguishable
//     from one that was never set, so blank GHL values never erase
//     dashboard data.

import { query } from '@/lib/db';
import { parseStudentSlotKey } from './slot-keys';

const SKIP_BASES = new Set([
  'first_name', 'last_name', 'preferred_name', 'birth_date', 'gender', 'id',
]);

// Map the GHL contact's free-text "Student Enrollment Status" to our
// enrollments.status enum, so the Family Hub / roster / enrollment
// dashboards (which read enrollments.status) stay consistent with the
// contact record. Unrecognized values are left alone — we never clobber
// a real status with a guess.
function mapEnrollmentStatus(raw: string): string | null {
  const t = raw.trim().toLowerCase();
  if (!t) return null;
  if (/(re-?enroll|^enrolled|currently enrolled)/.test(t)) return 'enrolled';
  if (t.startsWith('accept')) return 'accepted';
  if (t.startsWith('pending')) return 'pending';
  if (t.startsWith('withdraw')) return 'withdrawn';
  if (t.startsWith('declin')) return 'declined';
  if (t.startsWith('waitlist')) return 'waitlisted';
  if (t.startsWith('inquir')) return 'inquiry';
  if (/tour/.test(t)) return 'tour_scheduled';
  if (/(applied|application)/.test(t)) return 'application_submitted';
  return null;
}

// Real-time variant used by the GHL contact webhook: propagate ONE
// contact's freshly-fetched custom fields into the students.metadata of
// ONE family, so an edit in the GHL contact record reflects on every
// dashboard within seconds instead of waiting for the 15-min cron. Same
// slot logic + enrollment-status reconciliation as the full refresh, but
// reads from the live contact (idByKey + cfById passed by the webhook)
// rather than the ghl_contact_field_values mirror (which is still stale
// at webhook time). `q` is the caller's transaction handle.
export async function propagateContactFieldsToFamilyMetadata(
  q: typeof query,
  schoolId: string,
  familyId: string,
  idByKey: Map<string, string>,    // field_key  → field_id
  cfById: Map<string, unknown>,    // field_id   → value
): Promise<{ students_updated: number; keys_updated: number; enrollments_reconciled: number }> {
  // Build slot → base → value from the live contact's fields.
  const bySlot = new Map<number, Map<string, string>>();
  for (const [key, id] of idByKey) {
    const parsed = parseStudentSlotKey(key);
    if (!parsed) continue;
    const { slot, base } = parsed;
    if (SKIP_BASES.has(base)) continue;
    const raw = cfById.get(id);
    const v = raw == null ? '' : String(raw).trim();
    if (!v) continue;
    let bases = bySlot.get(slot);
    if (!bases) { bases = new Map(); bySlot.set(slot, bases); }
    bases.set(base, v);
  }
  const out = { students_updated: 0, keys_updated: 0, enrollments_reconciled: 0 };
  if (bySlot.size === 0) return out;

  const { rows: students } = await q<{ id: string; metadata: Record<string, unknown> | null }>(
    `SELECT id, metadata FROM students WHERE school_id = $1 AND family_id = $2 AND status = 'active'`,
    [schoolId, familyId],
  );
  for (const s of students) {
    const md = s.metadata ?? {};
    const slot = parseInt(String(md.ghl_slot ?? ''), 10);
    if (!Number.isInteger(slot) || slot < 1 || slot > 4) continue;
    const bases = bySlot.get(slot);
    if (!bases) continue;

    const ghlEnr = bases.get('enrollment_status');
    if (ghlEnr) {
      const mapped = mapEnrollmentStatus(ghlEnr);
      if (mapped) {
        const { rowCount } = await q(
          `UPDATE enrollments e SET status = $2, updated_at = now()
            WHERE e.student_id = $1
              AND e.academic_year = (SELECT MAX(academic_year) FROM enrollments WHERE student_id = $1)
              AND e.status <> $2`,
          [s.id, mapped],
        );
        if (rowCount && rowCount > 0) out.enrollments_reconciled += rowCount;
      }
    }

    const patch: Record<string, string> = {};
    for (const [base, v] of bases) {
      if (String(md[base] ?? '') !== v) patch[base] = v;
    }
    const n = Object.keys(patch).length;
    if (n === 0) continue;
    await q(
      `UPDATE students SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = now() WHERE id = $1`,
      [s.id, JSON.stringify(patch)],
    );
    out.students_updated++;
    out.keys_updated += n;
  }
  return out;
}

export interface MetadataRefreshResult {
  students_scanned: number;
  students_with_slot: number;
  students_updated: number;
  keys_updated: number;
  enrollments_reconciled: number;
  students_with_conflicts: number;
}

export async function refreshStudentMetadataFromGhl(schoolId: string): Promise<MetadataRefreshResult> {
  const { rows: parents } = await query<{ family_id: string; ghl_contact_id: string }>(
    `SELECT family_id, ghl_contact_id
       FROM parents
      WHERE school_id = $1 AND status = 'active' AND ghl_contact_id IS NOT NULL
      ORDER BY is_primary DESC, created_at ASC`,
    [schoolId],
  );
  const contactsByFamily = new Map<string, string[]>();
  for (const p of parents) {
    const list = contactsByFamily.get(p.family_id) ?? [];
    list.push(p.ghl_contact_id);
    contactsByFamily.set(p.family_id, list);
  }

  const { rows: cfv } = await query<{ ghl_contact_id: string; field_key: string; value: string }>(
    `SELECT ghl_contact_id, field_key, value
       FROM ghl_contact_field_values
      WHERE school_id = $1 AND field_key LIKE 'student%'`,
    [schoolId],
  );
  // contact → slot → base → value
  const bySlot = new Map<string, Map<number, Map<string, string>>>();
  for (const r of cfv) {
    const parsed = parseStudentSlotKey(r.field_key);
    if (!parsed) continue;
    const { slot, base } = parsed;
    if (SKIP_BASES.has(base)) continue;
    const v = (r.value ?? '').trim();
    if (!v) continue;
    let slots = bySlot.get(r.ghl_contact_id);
    if (!slots) { slots = new Map(); bySlot.set(r.ghl_contact_id, slots); }
    let bases = slots.get(slot);
    if (!bases) { bases = new Map(); slots.set(slot, bases); }
    bases.set(base, v);
  }

  const { rows: students } = await query<{ id: string; family_id: string; metadata: Record<string, unknown> | null }>(
    `SELECT id, family_id, metadata FROM students WHERE school_id = $1 AND status = 'active'`,
    [schoolId],
  );

  const result: MetadataRefreshResult = {
    students_scanned: students.length,
    students_with_slot: 0,
    students_updated: 0,
    keys_updated: 0,
    enrollments_reconciled: 0,
    students_with_conflicts: 0,
  };

  for (const s of students) {
    const md = s.metadata ?? {};
    const slot = parseInt(String(md.ghl_slot ?? ''), 10);
    if (!Number.isInteger(slot) || slot < 1 || slot > 4) continue;
    result.students_with_slot++;

    // First non-empty value across the family's contacts, primary
    // parent's contact first (the writeback mirrors slot fields onto
    // every linked parent, so they normally agree — ordering only
    // matters when the school edited just one contact). perBase also
    // tracks every distinct value per field so we can flag co-parent
    // contacts that DISAGREE (e.g. one says Enrolled, the other Accepted).
    const merged = new Map<string, string>();
    const perBase = new Map<string, Set<string>>();
    for (const contactId of contactsByFamily.get(s.family_id) ?? []) {
      const bases = bySlot.get(contactId)?.get(slot);
      if (!bases) continue;
      for (const [base, v] of bases) {
        if (!merged.has(base)) merged.set(base, v);
        const set = perBase.get(base) ?? new Set<string>();
        set.add(v);
        perBase.set(base, set);
      }
    }

    // Conflicts = fields where the linked contacts hold different values.
    // Stored on metadata.ghl_conflicts (or cleared) so the roster + a
    // cleanup export can surface exactly what to reconcile in GHL.
    const conflicts: Record<string, string[]> = {};
    for (const [base, set] of perBase) if (set.size > 1) conflicts[base] = [...set];
    const hasConflicts = Object.keys(conflicts).length > 0;
    const prevConf = md.ghl_conflicts ? JSON.stringify(md.ghl_conflicts) : null;
    const nextConf = hasConflicts ? JSON.stringify(conflicts) : null;
    if (prevConf !== nextConf) {
      if (hasConflicts) {
        await query(
          `UPDATE students SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('ghl_conflicts', $2::jsonb), updated_at = now() WHERE id = $1`,
          [s.id, nextConf],
        );
      } else {
        await query(`UPDATE students SET metadata = metadata - 'ghl_conflicts', updated_at = now() WHERE id = $1`, [s.id]);
      }
    }
    if (hasConflicts) result.students_with_conflicts++;

    if (merged.size === 0) continue;

    // Reconcile the enrollment status enum (read by every dashboard)
    // with the GHL contact's value, so the badge matches the contact
    // record. Touches only the student's most-recent enrollment, only
    // when the mapped status actually differs.
    const ghlEnr = merged.get('enrollment_status');
    if (ghlEnr) {
      const mapped = mapEnrollmentStatus(ghlEnr);
      if (mapped) {
        const { rowCount } = await query(
          `UPDATE enrollments e
              SET status = $2, updated_at = now()
            WHERE e.student_id = $1
              AND e.academic_year = (SELECT MAX(academic_year) FROM enrollments WHERE student_id = $1)
              AND e.status <> $2`,
          [s.id, mapped],
        );
        if (rowCount && rowCount > 0) result.enrollments_reconciled += rowCount;
      }
    }

    const patch: Record<string, string> = {};
    for (const [base, v] of merged) {
      const existing = md[base];
      if (String(existing ?? '') !== v) patch[base] = v;
    }
    const n = Object.keys(patch).length;
    if (n === 0) continue;

    await query(
      `UPDATE students
          SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
              updated_at = now()
        WHERE id = $1`,
      [s.id, JSON.stringify(patch)],
    );
    result.students_updated++;
    result.keys_updated += n;
  }

  return result;
}
