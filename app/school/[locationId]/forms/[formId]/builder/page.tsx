// /school/[locationId]/forms/[formId]/builder — the drag-and-drop form
// builder (v2). Loads the form and hands its field_schema to the client
// builder, which saves through the same PATCH endpoint the classic editor uses.

import { notFound } from 'next/navigation';
import { query } from '@/lib/db';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { FormBuilderV2, type FieldBlock } from './FormBuilderV2';

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

  return (
    <FormBuilderV2
      schoolId={school.id}
      formId={form.id}
      slug={form.slug}
      displayName={form.display_name}
      initialSchema={(form.field_schema ?? []) as FieldBlock[]}
      previewHref={`/school/${locationId}/forms/${formId}/preview?chrome=none`}
      backHref={`/school/${locationId}/forms`}
    />
  );
}
