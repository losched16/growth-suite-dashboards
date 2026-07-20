// Auto-fill "Student N Program Name" from "Student N Grade Level".
//
// DGM's office (Leslie) sets only the grade code (P2, U5, M7, …); the
// program bucket is derivable — this backfill writes it to the GHL
// contact (source of truth first, same as the student-id backfill) and
// mirrors students.metadata so dashboards update immediately. Only
// fills BLANK program fields — never overwrites an office-set value.
//
// Gated on schools.settings.derive_program_from_grade.

import { query } from '@/lib/db';
import { loadGhlClient } from '@/lib/ghl/client';
import { loadSchoolSettings } from '@/lib/school-settings';

// Grade code → program bucket (DGM's naming; matches the enrollment
// agreement's option values).
const GRADE_TO_PROGRAM: Record<string, string> = {
  IN: 'Infant',
  T1: 'Toddler', T2: 'Toddler',
  P1: 'Primary', P2: 'Primary', P3: 'Primary',
  L1: 'Lower Elementary', L2: 'Lower Elementary', L3: 'Lower Elementary',
  U4: 'Upper Elementary', U5: 'Upper Elementary', U6: 'Upper Elementary',
  M0: 'Middle Years/High School', M7: 'Middle Years/High School',
  M8: 'Middle Years/High School', M9: 'Middle Years/High School',
  D1: 'Middle Years/High School', D2: 'Middle Years/High School',
};

export interface ProgramFromGradeResult {
  ran: boolean;
  filled: number;
  errors: number;
}

export async function backfillProgramFromGrade(schoolId: string): Promise<ProgramFromGradeResult> {
  const result: ProgramFromGradeResult = { ran: false, filled: 0, errors: 0 };
  const settings = await loadSchoolSettings(schoolId);
  if (!settings.derive_program_from_grade) return result;
  result.ran = true;

  const { rows: targets } = await query<{ id: string; slot: string; cid: string; grade: string }>(
    `SELECT s.id, COALESCE(s.metadata->>'ghl_slot', '1') AS slot,
            s.metadata->>'ghl_contact_id' AS cid, btrim(s.metadata->>'grade_level') AS grade
       FROM students s
      WHERE s.school_id = $1 AND s.status = 'active'
        AND NULLIF(btrim(s.metadata->>'grade_level'), '') IS NOT NULL
        AND NULLIF(btrim(s.metadata->>'program_name'), '') IS NULL
        AND s.metadata->>'ghl_contact_id' IS NOT NULL`,
    [schoolId],
  );
  if (targets.length === 0) return result;

  const { rows: cat } = await query<{ field_key: string; ghl_field_id: string }>(
    `SELECT field_key, ghl_field_id FROM school_field_catalog
      WHERE school_id = $1 AND field_key ~ '^student_[0-9]_program_name$'`,
    [schoolId],
  );
  const idByKey = new Map(cat.map((r) => [r.field_key, r.ghl_field_id]));

  const client = await loadGhlClient(schoolId);
  for (const t of targets) {
    const program = GRADE_TO_PROGRAM[t.grade.toUpperCase()];
    const fieldId = idByKey.get(`student_${t.slot}_program_name`);
    if (!program || !fieldId) continue;
    try {
      await client.axios.put(`/contacts/${t.cid}`, {
        customFields: [{ id: fieldId, field_value: program }],
      });
      await query(
        `UPDATE students SET metadata = jsonb_set(metadata, '{program_name}', to_jsonb($2::text)), updated_at = now()
          WHERE id = $1`,
        [t.id, program],
      ).catch(() => undefined);
      result.filled++;
      await new Promise((r) => setTimeout(r, 150));
    } catch (e) {
      result.errors++;
      console.warn('[program-from-grade] failed for student', t.id, ':', e instanceof Error ? e.message : String(e));
    }
  }
  return result;
}
