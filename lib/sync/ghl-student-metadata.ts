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

const SLOT_KEY_RE = /^student_(?:([2-4])_)?(.+)$/;

const SKIP_BASES = new Set([
  'first_name', 'last_name', 'preferred_name', 'birth_date', 'gender', 'id',
]);

export interface MetadataRefreshResult {
  students_scanned: number;
  students_with_slot: number;
  students_updated: number;
  keys_updated: number;
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
    const m = SLOT_KEY_RE.exec(r.field_key);
    if (!m) continue;
    const slot = m[1] ? parseInt(m[1], 10) : 1;
    const base = m[2];
    if (!base || SKIP_BASES.has(base)) continue;
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
  };

  for (const s of students) {
    const md = s.metadata ?? {};
    const slot = parseInt(String(md.ghl_slot ?? ''), 10);
    if (!Number.isInteger(slot) || slot < 1 || slot > 4) continue;
    result.students_with_slot++;

    // First non-empty value across the family's contacts, primary
    // parent's contact first (the writeback mirrors slot fields onto
    // every linked parent, so they normally agree — ordering only
    // matters when the school edited just one contact).
    const merged = new Map<string, string>();
    for (const contactId of contactsByFamily.get(s.family_id) ?? []) {
      const bases = bySlot.get(contactId)?.get(slot);
      if (!bases) continue;
      for (const [base, v] of bases) {
        if (!merged.has(base)) merged.set(base, v);
      }
    }
    if (merged.size === 0) continue;

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
