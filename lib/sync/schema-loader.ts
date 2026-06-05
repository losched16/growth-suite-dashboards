// Per-school field-schema loader. Reads from school_field_schemas table.
// Falls back to the Desert Garden Montessori preset for any school
// without a row, so legacy schools keep working without backfill.
//
// Operator edits this via /admin/{schoolId} (form-based) or via
// /api/admin/schools/{id}/field-schema (raw JSON PUT).

import { query } from '@/lib/db';
import {
  FAMILY_FIELDS as DG_FAMILY,
  PARENT2_FIELDS as DG_PARENT2,
  STUDENT_FIELDS as DG_STUDENT,
  MAX_STUDENT_SLOTS as DG_MAX_SLOTS,
  DEFAULT_ACADEMIC_YEAR as DG_YEAR,
} from './desert-garden-config';

export interface SchoolFieldSchema {
  family_fields: Record<string, string>;   // abstract name → GHL fieldKey
  parent2_fields: Record<string, string>;
  student_fields: Record<string, string>;
  max_student_slots: number;
  default_academic_year: string;
  notes: string | null;
  is_default: boolean; // true if no row, returning DG fallback
  // When true, the GHL sync keeps families with zero student rows
  // (used for schools that track parents in GHL but not students).
  // Default false — every existing school keeps current behavior.
  allow_parent_only_families: boolean;
}

// Built-in Desert Garden Montessori preset. Schools that don't have an
// explicit row inherit this. Also returned by `getDefaultSchema()` for
// the admin "reset to defaults" / "show me a starting point" UX.
export function getDefaultSchema(): SchoolFieldSchema {
  return {
    family_fields: { ...DG_FAMILY },
    parent2_fields: { ...DG_PARENT2 },
    student_fields: { ...DG_STUDENT },
    max_student_slots: DG_MAX_SLOTS,
    default_academic_year: DG_YEAR,
    notes: 'Defaulted to Desert Garden Montessori preset (no custom schema configured for this school).',
    is_default: true,
    allow_parent_only_families: false,
  };
}

interface DbRow {
  family_fields: Record<string, string>;
  parent2_fields: Record<string, string>;
  student_fields: Record<string, string>;
  max_student_slots: number;
  default_academic_year: string;
  notes: string | null;
  allow_parent_only_families: boolean;
}

export async function loadSchoolFieldSchema(schoolId: string): Promise<SchoolFieldSchema> {
  const { rows } = await query<DbRow>(
    `SELECT family_fields, parent2_fields, student_fields,
            max_student_slots, default_academic_year, notes,
            allow_parent_only_families
     FROM school_field_schemas WHERE school_id = $1`,
    [schoolId],
  );
  if (rows.length === 0) return getDefaultSchema();

  const row = rows[0];
  // Per-section MERGE: defaults sit underneath, saved values override.
  // This way when we add a new field key to the DG preset, schools that
  // saved a config before the addition still pick it up automatically.
  // Saved keys still take precedence — operator can override anything.
  return {
    family_fields: { ...DG_FAMILY, ...row.family_fields },
    parent2_fields: { ...DG_PARENT2, ...row.parent2_fields },
    student_fields: { ...DG_STUDENT, ...row.student_fields },
    max_student_slots: row.max_student_slots,
    default_academic_year: row.default_academic_year,
    notes: row.notes,
    is_default: false,
    allow_parent_only_families: !!row.allow_parent_only_families,
  };
}

export async function upsertSchoolFieldSchema(
  schoolId: string,
  schema: Omit<SchoolFieldSchema, 'is_default'>,
): Promise<void> {
  await query(
    `INSERT INTO school_field_schemas
       (school_id, family_fields, parent2_fields, student_fields,
        max_student_slots, default_academic_year, notes,
        allow_parent_only_families)
     VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5, $6, $7, $8)
     ON CONFLICT (school_id) DO UPDATE SET
       family_fields = EXCLUDED.family_fields,
       parent2_fields = EXCLUDED.parent2_fields,
       student_fields = EXCLUDED.student_fields,
       max_student_slots = EXCLUDED.max_student_slots,
       default_academic_year = EXCLUDED.default_academic_year,
       notes = EXCLUDED.notes,
       allow_parent_only_families = EXCLUDED.allow_parent_only_families`,
    [
      schoolId,
      JSON.stringify(schema.family_fields),
      JSON.stringify(schema.parent2_fields),
      JSON.stringify(schema.student_fields),
      schema.max_student_slots,
      schema.default_academic_year,
      schema.notes,
      schema.allow_parent_only_families,
    ],
  );
}
