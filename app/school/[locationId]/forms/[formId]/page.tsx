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
import { ArrowLeft, ExternalLink } from 'lucide-react';
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
}

const PARENT_PORTAL_BASE = process.env.PARENT_PORTAL_BASE_URL
  ?? 'https://growth-suite-parent-portal.vercel.app';

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
            one_submission_per_year, field_schema
       FROM portal_form_definitions
      WHERE id = $1 AND school_id = $2`,
    [formId, school.id],
  );
  if (rows.length === 0) notFound();
  const form = rows[0];

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
            <a
              href={`${PARENT_PORTAL_BASE}/forms-v2/${form.slug}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <ExternalLink className="h-3 w-3" /> Preview as parent
            </a>
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
          }}
        />
      </div>
    </main>
  );
}
