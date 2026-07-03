// Auto-assign a Student ID to any active student that doesn't have one yet.
//
// For opted-in schools (settings.auto_student_ids) we generate a random, unique
// 8-digit Student ID for each new student. The ID is written to the GHL
// contact FIRST (student_<slot>_student_id) so it lands in the source of truth
// and survives the destructive snapshot sync, then mirrored to
// students.metadata.student_id so the portal / FACTS card shows it immediately.
//
// Best-effort: called after the family-graph sync in the cron. Any failure is
// logged + skipped, and the student is retried on the next run. We deliberately
// write GHL BEFORE the DB so we never leave a DB-only id that the next snapshot
// rebuild would wipe (regenerating a different number).

import { query } from '@/lib/db';
import { loadGhlClient, type GhlClient } from '@/lib/ghl/client';

import { loadSchoolSettings } from '@/lib/school-settings';

export interface StudentIdBackfillResult {
  ran: boolean;
  assigned: number;
  ghl_written: number;
  errors: string[];
}

function random8(): string {
  return String(Math.floor(10000000 + Math.random() * 90000000));
}

// Possible GHL field keys for a slot's student id. DGM uses the slotted form
// (student_1_student_id); some schools use the bare slot-1 form.
function candidateKeys(slot: number): string[] {
  return slot === 1
    ? ['student_1_student_id', 'student_student_id']
    : [`student_${slot}_student_id`];
}

export async function backfillStudentIds(schoolId: string): Promise<StudentIdBackfillResult> {
  const settings = await loadSchoolSettings(schoolId);
  if (!settings.auto_student_ids) return { ran: false, assigned: 0, ghl_written: 0, errors: [] };

  const { rows: students } = await query<{ id: string; slot: number; contact_id: string | null }>(
    `SELECT s.id,
            COALESCE((s.metadata->>'ghl_slot')::int, 1) AS slot,
            (SELECT p.ghl_contact_id FROM parents p
              WHERE p.family_id = s.family_id AND p.is_primary = true
                AND p.ghl_contact_id IS NOT NULL
              ORDER BY p.created_at LIMIT 1) AS contact_id
       FROM students s
      WHERE s.school_id = $1 AND s.status = 'active'
        AND NULLIF(btrim(s.metadata->>'student_id'), '') IS NULL`,
    [schoolId],
  );
  if (students.length === 0) return { ran: true, assigned: 0, ghl_written: 0, errors: [] };

  // Collision guard — never reuse an id already on the roster (or minted this run).
  const { rows: ex } = await query<{ sid: string }>(
    `SELECT DISTINCT btrim(metadata->>'student_id') AS sid
       FROM students WHERE school_id = $1 AND btrim(COALESCE(metadata->>'student_id','')) <> ''`,
    [schoolId],
  );
  const used = new Set(ex.map((r) => r.sid));
  const freshId = (): string => { let id = random8(); while (used.has(id)) id = random8(); used.add(id); return id; };

  let client: GhlClient | null = null;
  try { client = await loadGhlClient(schoolId); } catch { /* GHL unavailable — skip this run */ }
  let fieldDefs: Array<{ id: string; fieldKey?: string }> = [];
  if (client) {
    try {
      fieldDefs = (await client.axios.get<{ customFields?: Array<{ id: string; fieldKey?: string }> }>(
        `/locations/${client.locationId}/customFields`)).data?.customFields ?? [];
    } catch { /* leave empty — no writeback possible this run */ }
  }

  const errors: string[] = [];
  let assigned = 0;
  let ghlWritten = 0;
  for (const s of students) {
    if (!client || !s.contact_id) { errors.push(`no_ghl_contact:${s.id}`); continue; }
    const keys = candidateKeys(s.slot);
    const def = fieldDefs.find((f) => f.fieldKey && (keys.includes(f.fieldKey) || keys.some((k) => f.fieldKey!.endsWith(`.${k}`))));
    if (!def) { errors.push(`no_ghl_field:${keys[0]}`); continue; }

    const id = freshId();
    try {
      await client.axios.put(`/contacts/${s.contact_id}`, { customFields: [{ id: def.id, field_value: id }] });
      ghlWritten++;
      await query(
        `UPDATE students SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{student_id}', to_jsonb($2::text), true) WHERE id = $1`,
        [s.id, id],
      );
      assigned++;
    } catch (e) {
      errors.push(`ghl_put:${s.id}:${e instanceof Error ? e.message : String(e)}`);
    }
    await new Promise((r) => setTimeout(r, 120)); // pace to dodge GHL 429
  }
  return { ran: true, assigned, ghl_written: ghlWritten, errors };
}
