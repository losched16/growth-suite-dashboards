// /school/[locationId]/forms/[formId]/builder — the drag-and-drop form
// builder (v2). Loads the form and hands its field_schema to the client
// builder, which saves through the same PATCH endpoint the classic editor uses.

import { notFound } from 'next/navigation';
import { query } from '@/lib/db';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { loadGhlClient } from '@/lib/ghl/client';
import { FormBuilderV2, type FieldBlock, type GhlField, type FormAppliesTo } from './FormBuilderV2';

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
    description: string | null; confirmation_message: string | null;
    notify_emails: string[] | null; per_student: boolean;
    resubmission_allowed: boolean; is_active: boolean;
    applies_to: Record<string, unknown> | null;
  }>(
    `SELECT id, slug, display_name, field_schema,
            description, confirmation_message, notify_emails,
            per_student, resubmission_allowed, is_active, applies_to
       FROM portal_form_definitions
      WHERE id = $1 AND school_id = $2`,
    [formId, school.id],
  );
  if (rows.length === 0) notFound();
  const form = rows[0];

  // "Who sees this form" checklists — distinct program / grade / tag values on
  // this school's roster (demo students excluded). Same source the classic
  // editor uses, so both editors offer identical targeting choices.
  const [progRows, gradeRows, tagRows, metaKeyRows, ghlFields] = await Promise.all([
    query<{ v: string }>(
      `SELECT DISTINCT s.metadata->>'program' AS v FROM students s
        WHERE s.school_id = $1 AND btrim(coalesce(s.metadata->>'program','')) <> ''
          AND (s.metadata->>'is_demo') IS DISTINCT FROM 'true' ORDER BY 1`,
      [school.id],
    ),
    query<{ v: string }>(
      `SELECT DISTINCT s.metadata->>'grade_level' AS v FROM students s
        WHERE s.school_id = $1 AND btrim(coalesce(s.metadata->>'grade_level','')) <> ''
          AND (s.metadata->>'is_demo') IS DISTINCT FROM 'true' ORDER BY 1`,
      [school.id],
    ),
    query<{ v: string }>(
      `SELECT DISTINCT tag AS v FROM ghl_contact_tags
        WHERE school_id = $1 AND btrim(coalesce(tag,'')) <> '' ORDER BY 1`,
      [school.id],
    ),
    // Distinct students.metadata keys — the ground truth of what a form field
    // can prefill (the sync mirrors each contact field's value under these
    // keys). The builder alias-matches a connected GHL field to one of these so
    // its prefill key is always one that actually resolves.
    query<{ v: string }>(
      `SELECT DISTINCT k AS v FROM students s, jsonb_object_keys(s.metadata) AS k
        WHERE s.school_id = $1 AND s.metadata IS NOT NULL
          AND (s.metadata->>'is_demo') IS DISTINCT FROM 'true' ORDER BY 1`,
      [school.id],
    ),
    loadGhlFields(school.id),
  ]);

  return (
    <FormBuilderV2
      schoolId={school.id}
      formId={form.id}
      slug={form.slug}
      displayName={form.display_name}
      initialSchema={(form.field_schema ?? []) as FieldBlock[]}
      initialSettings={{
        display_name: form.display_name,
        description: form.description,
        confirmation_message: form.confirmation_message,
        notify_emails: form.notify_emails ?? [],
        per_student: form.per_student,
        resubmission_allowed: form.resubmission_allowed,
        is_active: form.is_active,
        applies_to: (form.applies_to ?? null) as FormAppliesTo | null,
      }}
      ghlFields={ghlFields}
      metadataKeys={metaKeyRows.rows.map((r) => r.v)}
      programOptions={progRows.rows.map((r) => r.v)}
      gradeOptions={gradeRows.rows.map((r) => r.v)}
      tagOptions={tagRows.rows.map((r) => r.v)}
      previewHref={`/school/${locationId}/forms/${formId}/preview?chrome=none`}
      backHref={`/school/${locationId}/forms`}
    />
  );
}
