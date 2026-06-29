// /school/[locationId]/forms/[formId]/preview — school-staff standalone
// preview of a form. Mirrors /admin/[schoolId]/forms/[formId]/preview
// but lives in /school/* so it stays inside the GHL iframe and is
// gated by the school session cookie (NOT the parent or operator
// cookies). No real submission, no parent data leakage — dummy values
// fill any prefill references.
//
// This is what the "Open form (logged-out preview)" button on the
// Forms tab points to. Previously that button linked to the parent-
// portal URL which forced a parent login screen — wrong for staff who
// just want to eyeball the layout.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Edit3, Eye, FlaskConical } from 'lucide-react';
import { query } from '@/lib/db';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { FormPreviewRenderer } from '@/app/admin/[schoolId]/forms/[formId]/preview/FormPreviewRenderer';
import { TestSubmitForm } from './TestSubmitForm';

export const dynamic = 'force-dynamic';

type Params = Promise<{ locationId: string; formId: string }>;
type SearchParams = Promise<{
  per_student_view?: 'one' | 'multi';
  test?: string;
}>;

interface FormDefRow {
  id: string;
  slug: string;
  display_name: string;
  description: string | null;
  category: string | null;
  per_student: boolean;
  field_schema: unknown[];
  is_active: boolean;
  needs_review: boolean;
  allow_addendum: boolean;
  payment_config: Record<string, unknown> | null;
}

export default async function SchoolFormPreviewPage({
  params, searchParams,
}: { params: Params; searchParams: SearchParams }) {
  const { locationId, formId } = await params;
  const sp = await searchParams;

  // The school iframe already runs behind the school-session middleware,
  // so by the time we reach this page the session cookie is verified.
  // We resolve locationId → schoolId via the standard loader.
  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();

  const { rows: formRows } = await query<FormDefRow>(
    `SELECT id, slug, display_name, description, category, per_student,
            field_schema, is_active, needs_review, allow_addendum,
            payment_config
       FROM portal_form_definitions
      WHERE id = $1 AND school_id = $2`,
    [formId, school.id],
  );
  if (formRows.length === 0) notFound();
  const form = formRows[0];

  const showPerStudentPicker = form.per_student && sp.per_student_view !== 'one';
  const testMode = sp.test === '1';
  const hasPayment = !!form.payment_config;

  const baseUrl = `/school/${locationId}/forms/${formId}/preview?chrome=none`;
  const layoutPreviewUrl = baseUrl;
  const testModeUrl = baseUrl + '&test=1';

  return (
    <main className="min-h-screen bg-zinc-100">
      {/* Sticky staff-only header — looks nothing like the real portal
          so staff never confuse it for a live view. Distinct color in
          test mode (emerald) so they can't miss that a submit will
          actually persist. */}
      <div className={
        testMode
          ? 'sticky top-0 z-10 border-b border-emerald-400 bg-emerald-50 px-4 py-2 text-xs'
          : 'sticky top-0 z-10 border-b border-amber-300 bg-amber-50 px-4 py-2 text-xs'
      }>
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 flex-wrap">
          <div className={`flex items-center gap-2 ${testMode ? 'text-emerald-900' : 'text-amber-900'}`}>
            {testMode ? <FlaskConical className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            <strong>{testMode ? 'TEST MODE' : 'PREVIEW MODE'}</strong>
            <span className={testMode ? 'text-emerald-800' : 'text-amber-800'}>
              · {school.name} · {form.display_name} (slug: <code>{form.slug}</code>)
            </span>
            {!form.is_active ? (
              <span className="rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-700">
                inactive
              </span>
            ) : null}
            {form.needs_review ? (
              <span className="rounded bg-amber-200 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-900">
                needs review
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {/* Toggle between read-only Preview and interactive Test mode */}
            {testMode ? (
              <Link
                href={layoutPreviewUrl}
                className="inline-flex items-center gap-1 rounded border border-emerald-500 bg-white px-2 py-1 text-emerald-900 hover:bg-emerald-100"
              >
                <Eye className="h-3 w-3" /> Switch to read-only preview
              </Link>
            ) : (
              <Link
                href={testModeUrl}
                className="inline-flex items-center gap-1 rounded border border-emerald-500 bg-emerald-600 px-2 py-1 font-semibold text-white hover:bg-emerald-700"
                title="Enable fields, submit a real (is_test=true) submission, see what the parent sees + a dry-run report of every downstream effect."
              >
                <FlaskConical className="h-3 w-3" /> Enter test mode
              </Link>
            )}
            <Link
              href={`/school/${locationId}/forms/${formId}?chrome=none`}
              className={
                testMode
                  ? 'inline-flex items-center gap-1 rounded border border-emerald-400 bg-white px-2 py-1 text-emerald-900 hover:bg-emerald-100'
                  : 'inline-flex items-center gap-1 rounded border border-amber-400 bg-white px-2 py-1 text-amber-900 hover:bg-amber-100'
              }
            >
              <Edit3 className="h-3 w-3" /> Back to editor
            </Link>
            <Link
              href={`/school/${locationId}/forms`}
              className={testMode ? 'inline-flex items-center gap-1 text-emerald-800 hover:underline' : 'inline-flex items-center gap-1 text-amber-800 hover:underline'}
            >
              <ArrowLeft className="h-3 w-3" /> All forms
            </Link>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-3xl px-4 py-6 sm:py-8">
        {/* Mimic the parent portal's form page header */}
        <div className="mb-5">
          <h1 className="text-2xl font-semibold text-zinc-900">{form.display_name}</h1>
          {form.description ? (
            <p className="mt-1 text-sm text-zinc-600 whitespace-pre-wrap">{form.description}</p>
          ) : null}
        </div>

        {showPerStudentPicker ? (
          <div className="mb-5 rounded-lg border border-zinc-200 bg-white p-4">
            <div className="text-sm font-semibold text-zinc-900 mb-2">For which student?</div>
            <p className="text-xs text-zinc-600 mb-2">
              Per-student form. In production, the parent picks a child and the form repeats for each.
            </p>
            <div className="flex flex-wrap gap-2 text-sm">
              <div className="rounded-md border-2 border-emerald-600 bg-emerald-50 px-3 py-1.5">
                Charlie Sample (preview)
              </div>
              <div className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-zinc-500">
                Other students…
              </div>
            </div>
          </div>
        ) : null}

        {testMode ? (
          <>
            <div className="mb-4 rounded-md border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-xs text-emerald-900">
              Fields are <strong>live</strong>. Filling and submitting will store a test row
              (marked <code>is_test=true</code>, hidden from the regular inbox) and show you the
              real thank-you experience plus a dry-run report of everything that <em>would</em> have
              fired in production.
            </div>
            <TestSubmitForm
              schoolId={school.id}
              formId={form.id}
              schema={form.field_schema}
              perStudent={form.per_student}
              hasPayment={hasPayment}
              returnTo={`/school/${locationId}/forms/${form.id}/preview/result`}
            />
          </>
        ) : (
          <>
            <FormPreviewRenderer schema={form.field_schema} />
            <div className="mt-6 flex items-center gap-3 border-t border-zinc-200 pt-4">
              <button
                type="button"
                disabled
                className="rounded-md px-4 py-2 text-sm font-semibold text-white opacity-60 cursor-not-allowed"
                style={{ background: '#047857' }}
              >
                {hasPayment ? 'Continue to payment' : 'Submit form'}
              </button>
              <Link
                href={testModeUrl}
                className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
              >
                <FlaskConical className="h-4 w-4" /> Switch to Test mode &mdash; actually submit
              </Link>
              <span className="text-xs text-zinc-500">
                Read-only preview. Click &ldquo;Test mode&rdquo; to enable fields and fire a real test submission.
              </span>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
