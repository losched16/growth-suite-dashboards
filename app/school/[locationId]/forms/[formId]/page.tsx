// /school/[locationId]/forms/[formId] — school-scoped form editor.
//
// Mirrors /admin/[schoolId]/forms/[formId] but lives in /school/* so
// the back chain stays inside the GHL-embedded iframe. The /admin/*
// surface still exists for direct operator access.
//
// The form-editor PATCH endpoint is at /api/admin/schools/{schoolId}/
// forms/{formId} — we resolve locationId → schoolId server-side and
// pass schoolId to the client editor so it can call that API directly.
// (The API itself is school-scoped and the auth cookie is school-scoped,
// so there's no auth escape.)

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Eye, Wand2 } from 'lucide-react';
import { query } from '@/lib/db';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { FormEditor } from '@/app/admin/[schoolId]/forms/[formId]/FormEditor';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type Params = Promise<{ locationId: string; formId: string }>;
type SearchParams = Promise<{ msg?: string; err?: string }>;

interface FormDefRow {
  id: string;
  slug: string;
  display_name: string;
  description: string | null;
  category: string | null;
  per_student: boolean;
  is_active: boolean;
  allow_addendum: boolean;
  needs_review: boolean;
  resubmission_allowed: boolean;
  one_submission_per_year: boolean;
  field_schema: unknown[];
  confirmation_message: string | null;
  confirmation_redirect_url: string | null;
  notify_emails: string[] | null;
  webhook_urls: string[] | null;
  applies_to: {
    program_match?: string[];
    tuition_grid_match?: string[];
    metadata_match?: Record<string, string[]>;
    addon_keys?: string[];
    student_ids?: string[];
  } | null;
}

export default async function FormEditPageScoped({
  params, searchParams,
}: { params: Params; searchParams: SearchParams }) {
  const { locationId, formId } = await params;
  const sp = await searchParams;

  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();

  const { rows } = await query<FormDefRow>(
    `SELECT id, slug, display_name, description, category, per_student,
            is_active, allow_addendum, needs_review, resubmission_allowed,
            one_submission_per_year, field_schema,
            confirmation_message, confirmation_redirect_url, notify_emails,
            webhook_urls, applies_to
       FROM portal_form_definitions
      WHERE id = $1 AND school_id = $2`,
    [formId, school.id],
  );
  if (rows.length === 0) notFound();
  const form = rows[0];

  // Official-PDF template attached to this form (DocuSign-style flow):
  // parents fill the portal form; answers are written onto the actual PDF.
  const { rows: tplRows } = await query<{
    file_name: string; page_count: number | null; field_count: number; updated_at: string;
  }>(
    `SELECT file_name, page_count, jsonb_array_length(field_inventory) AS field_count,
            updated_at::text AS updated_at
       FROM portal_form_pdf_templates WHERE form_definition_id = $1`,
    [formId],
  );
  const pdfTemplate = tplRows[0] ?? null;
  const mappedCount = (form.field_schema ?? []).filter(
    (b) => typeof (b as { pdf_field?: unknown }).pdf_field === 'string',
  ).length;

  // Distinct program values on this school's roster — drives the
  // "Who sees this form" checklist. Demo/test students excluded so the
  // list reflects real programs only.
  const { rows: progRows } = await query<{ program: string }>(
    `SELECT DISTINCT s.metadata->>'program' AS program
       FROM students s
      WHERE s.school_id = $1
        AND btrim(coalesce(s.metadata->>'program','')) <> ''
        AND (s.metadata->>'is_demo') IS DISTINCT FROM 'true'
      ORDER BY 1`,
    [school.id],
  );
  const programOptions = progRows.map((r) => r.program);

  // Distinct grade levels on the roster — lets the school target a form by
  // grade (e.g. Kindergarten) even when that grade lives inside a broader
  // program. Backed by applies_to.metadata_match.grade_level.
  const { rows: gradeRows } = await query<{ grade_level: string }>(
    `SELECT DISTINCT s.metadata->>'grade_level' AS grade_level
       FROM students s
      WHERE s.school_id = $1
        AND btrim(coalesce(s.metadata->>'grade_level','')) <> ''
        AND (s.metadata->>'is_demo') IS DISTINCT FROM 'true'
      ORDER BY 1`,
    [school.id],
  );
  const gradeOptions = gradeRows.map((r) => r.grade_level);

  // Distinct GHL contact tags synced for this school → "By tag" targeting.
  const { rows: tagRows } = await query<{ tag: string }>(
    `SELECT DISTINCT tag FROM ghl_contact_tags
      WHERE school_id = $1 AND btrim(coalesce(tag,'')) <> ''
      ORDER BY 1`,
    [school.id],
  );
  const tagOptions = tagRows.map((r) => r.tag);

  // Active students for the "Specific students" targeting picker.
  const { rows: studentRows } = await query<{ id: string; name: string; program: string | null }>(
    `SELECT s.id,
            CONCAT_WS(' ', COALESCE(NULLIF(s.preferred_name, ''), s.first_name), s.last_name) AS name,
            s.metadata->>'program' AS program
       FROM students s
      WHERE s.school_id = $1 AND s.status = 'active'
        AND (s.metadata->>'is_demo') IS DISTINCT FROM 'true'
      ORDER BY 2 LIMIT 2000`,
    [school.id],
  );


  return (
    <main className="flex flex-1 flex-col items-center bg-slate-50 p-6 min-h-screen">
      <div className="w-full max-w-4xl space-y-4">
        {/* Back link stays INSIDE the school iframe — go back to the
            standalone Parent Portal → Forms page. (Forms used to live as a
            tab in the Payments hub; that tab was removed.) */}
        <Link
          href={`/school/${locationId}/forms`}
          className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"
        >
          <ArrowLeft className="h-3 w-3" /> Back to Forms
        </Link>

        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">Edit form</h1>
            <div className="text-xs text-slate-500 font-mono">{form.slug}</div>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href={`/school/${locationId}/forms/${formId}/builder`}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
            >
              <Wand2 className="h-3.5 w-3.5" /> New builder
            </Link>
            <Link
              href={`/school/${locationId}/forms/${formId}/send`}
              className="inline-flex items-center gap-1.5 rounded-md border border-emerald-300 bg-white px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50"
            >
              Send to a family
            </Link>
            <Link
              href={`/school/${locationId}/forms/${formId}/submissions`}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              View submissions
            </Link>
            <Link
              href={`/school/${locationId}/forms/${formId}/preview?chrome=none`}
              className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
              title="Eyeball the form layout — opens inside this iframe, no login needed"
            >
              <Eye className="h-3 w-3" /> Preview layout
            </Link>
          </div>
        </div>

        {sp.msg ? (
          <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{sp.msg}</div>
        ) : null}
        {sp.err ? (
          <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{sp.err}</div>
        ) : null}

        {/* Official-PDF template — for unmodifiable state/agency forms.
            Upload the PDF as-is; its fillable fields become form fields
            below, and each submission produces the completed, signed PDF
            on the student's record. */}
        <section className="rounded-xl border border-black/10 bg-white p-5 space-y-3">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Official PDF template</h2>
              <p className="text-[11px] text-slate-500 mt-0.5">
                For forms that must stay on an official document (state emergency cards, agency
                forms): upload the fillable PDF as-is. Parents fill this form in the portal, and
                every submission generates the completed, signed PDF on the student&rsquo;s record.
              </p>
            </div>
          </div>
          {pdfTemplate ? (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
              <strong>{pdfTemplate.file_name}</strong> — {pdfTemplate.page_count ?? '?'} page(s),{' '}
              {pdfTemplate.field_count} fillable fields, {mappedCount} mapped to form fields below.
              Uploaded {new Date(pdfTemplate.updated_at).toLocaleDateString()}.
            </div>
          ) : (
            <p className="text-xs text-slate-500 italic">No PDF template attached — this is a regular portal form.</p>
          )}
          <form
            action={`/api/school/forms/${formId}/pdf-template`}
            method="POST"
            encType="multipart/form-data"
            className="flex items-center gap-2 flex-wrap"
          >
            <input type="hidden" name="return_to" value={`/school/${locationId}/forms/${formId}`} />
            <input type="file" name="file" accept="application/pdf,.pdf" required className="text-xs" />
            <button
              type="submit"
              className="rounded-md bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-900"
            >
              {pdfTemplate ? 'Replace PDF template' : 'Upload PDF template'}
            </button>
            <span className="text-[10px] text-slate-400">
              Fillable PDFs only (max 10MB). First upload generates one form field per PDF field —
              review the labels below, mark what&rsquo;s required, then publish.
            </span>
          </form>
        </section>

        <FormEditor
          schoolId={school.id}
          formId={form.id}
          slug={form.slug}
          initial={{
            display_name: form.display_name,
            description: form.description,
            category: form.category,
            per_student: form.per_student,
            is_active: form.is_active,
            allow_addendum: form.allow_addendum,
            needs_review: form.needs_review,
            resubmission_allowed: form.resubmission_allowed,
            one_submission_per_year: form.one_submission_per_year,
            field_schema: form.field_schema,
            confirmation_message: form.confirmation_message,
            confirmation_redirect_url: form.confirmation_redirect_url,
            notify_emails: form.notify_emails ?? [],
            webhook_urls: form.webhook_urls ?? [],
            applies_to: form.applies_to,
          }}
          programOptions={programOptions}
          gradeOptions={gradeOptions}
          studentOptions={studentRows}
          tagOptions={tagOptions}
        />
      </div>
    </main>
  );
}
