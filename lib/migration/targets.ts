// Load the set of mapping TARGETS for a school: the four native GHL contact
// fields plus every field in the school's own catalog (so the mapping adapts to
// whatever fields that school actually has in GHL). Server-only (hits the DB).

import { query } from '@/lib/db';
import { CORE_TARGETS, shapeFromDataType, type TargetField } from './csv-mapping';

export async function loadMigrationTargets(schoolId: string): Promise<TargetField[]> {
  const { rows } = await query<{ field_key: string; label: string | null; data_type: string | null; ghl_field_id: string | null }>(
    `SELECT field_key, label, data_type, ghl_field_id
       FROM school_field_catalog
      WHERE school_id = $1 AND missing_since IS NULL
      ORDER BY is_core DESC, label`,
    [schoolId],
  );
  const custom: TargetField[] = rows.map((r) => ({
    key: r.field_key,
    label: r.label || r.field_key,
    kind: 'custom',
    type: shapeFromDataType(r.data_type),
    ghl_field_id: r.ghl_field_id,
  }));
  // Core fields first so bare "First Name" / "Email" columns prefer the contact
  // fields; catalog customs (incl. student_N_*) follow.
  return [...CORE_TARGETS, ...custom];
}
