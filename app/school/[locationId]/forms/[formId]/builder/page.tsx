// /school/[locationId]/forms/[formId]/builder — the drag-and-drop form
// builder (v2). Loads the form and hands its field_schema to the client
// builder, which saves through the same PATCH endpoint the classic editor uses.

import { notFound } from 'next/navigation';
import { query } from '@/lib/db';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { loadGhlClient } from '@/lib/ghl/client';
import { FormBuilderV2, type FieldBlock, type GhlField } from './FormBuilderV2';

// The location's contact custom fields, for the "connect to Growth Suite field"
// picker. Best-effort — an empty list just means no picker suggestions.
async function loadGhlFields(schoolId: string): Promise<GhlField[]> {
  try {
    const client = await loadGhlClient(schoolId);
    const { data } = await client.axios.get<{ customFields?: Array<{ id: string; name?: string; fieldKey?: string; dataType?: string; picklistOptions?: unknown }> }>(
      `/locations/${client.locationId}/customFields`,
    );
    const out: GhlField[] = [];
    for (const f of data.customFields ?? []) {
      if (!f.fieldKey) continue;
      const key = f.fieldKey.replace(/^contact\./, '');
      // Skip parent/household/internal plumbing fields — parents don't map to those.
      if (/^(household_|parents_combined$)/.test(key)) continue;
      const opts = Array.isArray(f.picklistOptions)
        ? (f.picklistOptions as unknown[]).map((o) => (typeof o === 'string' ? o : String((o as { name?: string })?.name ?? ''))).filter(Boolean)
        : [];
      out.push({ key, name: f.name || key, dataType: f.dataType || 'TEXT', options: opts });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  } catch {
    return [];
  }
}

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type Params = Promise<{ locationId: string; formId: string }>;

export default async function FormBuilderPage({ params }: { params: Params }) {
  const { locationId, formId } = await params;

  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();

  const { rows } = await query<{
    id: string; slug: string; display_name: string; field_schema: unknown[];
  }>(
    `SELECT id, slug, display_name, field_schema
       FROM portal_form_definitions
      WHERE id = $1 AND school_id = $2`,
    [formId, school.id],
  );
  if (rows.length === 0) notFound();
  const form = rows[0];
  const ghlFields = await loadGhlFields(school.id);

  return (
    <FormBuilderV2
      schoolId={school.id}
      formId={form.id}
      slug={form.slug}
      displayName={form.display_name}
      initialSchema={(form.field_schema ?? []) as FieldBlock[]}
      ghlFields={ghlFields}
      previewHref={`/school/${locationId}/forms/${formId}/preview?chrome=none`}
      backHref={`/school/${locationId}/forms`}
    />
  );
}
