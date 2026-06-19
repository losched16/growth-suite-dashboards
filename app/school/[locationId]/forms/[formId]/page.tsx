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
import { ArrowLeft, Eye } from 'lucide-react';
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

  return (
    <main className="flex flex-1 flex-col items-center bg-slate-50 p-6 min-h-screen">
      <div className="w-full max-w-4xl space-y-4">
        {/* Back link stays INSIDE the school iframe — go back to the Forms
            tab in the Payments hub. No escape to /admin. */}
        <Link
          href={`/school/${locationId}/payments?tab=forms`}
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
        />
      </div>
    </main>
  );
}
