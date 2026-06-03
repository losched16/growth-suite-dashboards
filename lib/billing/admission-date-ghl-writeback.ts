// Push a student's admission date to the family's GHL contact custom
// field (`student_date_of_admission` for slot 1, `student_N_date_of_admission`
// for siblings).
//
// Called fire-and-forget from /api/school/students/set-admission-date.
// Best-effort — errors are logged, never bubble up.

import { query } from '@/lib/db';
import { loadGhlClient, type GhlClient } from '@/lib/ghl/client';
import { studentFieldKey } from '@/lib/sync/desert-garden-config';

interface CustomFieldDef { id: string; fieldKey?: string }

interface StudentRow {
  school_id: string;
  family_id: string;
  date_of_admission: string | null;
  student_slot: number;
  primary_parent_ghl_contact_id: string | null;
}

export interface AdmissionWritebackResult {
  ok: boolean;
  reason?: string;
  contactId?: string;
  fieldWritten?: string;
}

export async function writebackAdmissionDate(studentId: string): Promise<AdmissionWritebackResult> {
  const { rows } = await query<StudentRow>(
    `SELECT s.school_id, s.family_id,
            (s.metadata->>'date_of_admission') AS date_of_admission,
            COALESCE((s.metadata->>'slot')::int, 1) AS student_slot,
            (SELECT p.ghl_contact_id FROM parents p
              WHERE p.family_id = s.family_id AND p.is_primary = true
                AND p.ghl_contact_id IS NOT NULL
              ORDER BY p.created_at LIMIT 1) AS primary_parent_ghl_contact_id
       FROM students s WHERE s.id = $1`,
    [studentId],
  );
  if (rows.length === 0) return { ok: false, reason: 'student_not_found' };
  const s = rows[0];
  if (!s.primary_parent_ghl_contact_id) {
    return { ok: false, reason: 'no_ghl_contact_for_family' };
  }

  let client: GhlClient;
  try { client = await loadGhlClient(s.school_id); }
  catch (err) {
    return { ok: false, reason: `ghl_client: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Resolve the custom field ID for this slot.
  type Cf = { customFields?: CustomFieldDef[] };
  const { data: cfData } = await client.axios.get<Cf>(`/locations/${client.locationId}/customFields`);
  const fieldKey = studentFieldKey(s.student_slot, 'date_of_admission');
  const def = cfData.customFields?.find((f) => f.fieldKey === fieldKey || f.fieldKey?.endsWith(`.${fieldKey}`));
  if (!def) return { ok: false, reason: `no_ghl_field_for_${fieldKey}` };

  try {
    await client.axios.put(`/contacts/${s.primary_parent_ghl_contact_id}`, {
      customFields: [{ id: def.id, field_value: s.date_of_admission ?? '' }],
    });
    return { ok: true, contactId: s.primary_parent_ghl_contact_id, fieldWritten: fieldKey };
  } catch (err) {
    return { ok: false, reason: `ghl_put_failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
