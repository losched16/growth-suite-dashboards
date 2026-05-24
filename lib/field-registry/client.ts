import { query } from '@/lib/db';

// Reads from the importer's `ghl_field_registry` table. The dashboard
// platform consumes fields, never writes.

export interface RegistryField {
  id: string;
  school_id: string;
  field_key: string;       // snake_case key (e.g. "form_health_history_complete")
  field_name: string;      // human label (e.g. "Form: Health History Complete")
  field_type: string;      // GHL data type — TEXT, DATE, RADIO, etc.
  ghl_field_id: string;    // the GHL custom field ID
  ghl_folder_id: string | null;
  folder_name: string | null;
  options: string[] | null;
  required: boolean;
  source_documents: string[] | null;
}

export async function listFields(
  schoolId: string,
  filters?: { field_type?: string; field_key_like?: string; folder_name?: string }
): Promise<RegistryField[]> {
  const wheres: string[] = ['school_id = $1'];
  const params: unknown[] = [schoolId];

  if (filters?.field_type) {
    params.push(filters.field_type);
    wheres.push(`field_type = $${params.length}`);
  }
  if (filters?.field_key_like) {
    params.push(filters.field_key_like);
    wheres.push(`field_key ILIKE $${params.length}`);
  }
  if (filters?.folder_name) {
    params.push(filters.folder_name);
    wheres.push(`folder_name = $${params.length}`);
  }

  const { rows } = await query<RegistryField>(
    `SELECT id, school_id, field_key, field_name, field_type, ghl_field_id,
            ghl_folder_id, folder_name, options, required, source_documents
       FROM ghl_field_registry
       WHERE ${wheres.join(' AND ')}
       ORDER BY folder_name NULLS LAST, field_name`,
    params
  );
  return rows;
}

export async function getFieldsByKeys(
  schoolId: string,
  fieldKeys: string[]
): Promise<Map<string, RegistryField>> {
  if (fieldKeys.length === 0) return new Map();
  const { rows } = await query<RegistryField>(
    `SELECT id, school_id, field_key, field_name, field_type, ghl_field_id,
            ghl_folder_id, folder_name, options, required, source_documents
       FROM ghl_field_registry
       WHERE school_id = $1 AND field_key = ANY($2::text[])`,
    [schoolId, fieldKeys]
  );
  const m = new Map<string, RegistryField>();
  for (const r of rows) m.set(r.field_key, r);
  return m;
}

// Convenience for widget configs: extract a contact's value for a given
// field by looking up the GHL field id from the registry.
export function getCustomFieldValue(
  contact: { customFields?: Array<{ id: string; value: unknown }> },
  field: RegistryField | undefined
): string {
  if (!field) return '';
  const f = contact.customFields?.find((cf) => cf.id === field.ghl_field_id);
  if (!f || f.value === null || f.value === undefined) return '';
  if (Array.isArray(f.value)) return f.value.length > 0 ? f.value.join(', ') : '';
  return String(f.value).trim();
}
