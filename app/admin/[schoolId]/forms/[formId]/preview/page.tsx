// /admin/[schoolId]/forms/[formId]/preview — operator-only standalone
// preview of a form. Renders every block from the form's field_schema
// using a simplified renderer. No login required (operator session is
// already in place), no real submission, no parent data leakage —
// dummy values fill any prefill references.
//
// Use case: build the form in the editor, hit Preview, see exactly what
// the parent will see (visually) without having to spin up a test
// parent or open a different app.

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { ArrowLeft, Edit3, Eye } from 'lucide-react';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { query } from '@/lib/db';
import { FormPreviewRenderer } from './FormPreviewRenderer';

export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string; formId: string }>;
type SearchParams = Promise<{ per_student_view?: 'one' | 'multi' }>;

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

export default async function FormPreviewPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const ck = await cookies();
  if (!verifySessionToken(ck.get(SESSION_COOKIE)?.value)) redirect('/login');
  const { schoolId, formId } = await params;
  const sp = await searchParams;

  const { rows: schoolRows } = await query<{ name: string }>(
    `SELECT name FROM schools WHERE id = $1`, [schoolId],
  );
  if (schoolRows.length === 0) notFound();
  const school = schoolRows[0];

  const { rows: formRows } = await query<FormDefRow>(
    `SELECT id, slug, display_name, description, category, per_student,
            field_schema, is_active, needs_review, allow_addendum,
            payment_config
       FROM portal_form_definitions
      WHERE id = $1 AND school_id = $2`,
    [formId, schoolId],
  );
  if (formRows.length === 0) notFound();
  const form = formRows[0];

  const showPerStudentPicker = form.per_student && sp.per_student_view !== 'one';

  return (
    <main className="min-h-screen bg-zinc-100">
      {/* Sticky operator-only header — looks nothing like the real
          portal so the operator never confuses it for a live view. */}
      <div className="sticky top-0 z-10 border-b border-amber-300 bg-amber-50 px-4 py-2 text-xs">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 text-amber-900">
            <Eye className="h-4 w-4" />
            <strong>PREVIEW MODE</strong>
            <span className="text-amber-800">
              · {school.name} · {form.display_name} (slug: <code>{form.slug}</code>)
            </span>
            {!form.is_active ? (
              <span className="rounded bg-amber-200 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-900">
                draft · hidden from parents
              </span>
            ) : null}
            {form.needs_review ? (
              <span className="rounded bg-amber-200 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-900">
                needs review
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Link
              href={`/admin/${schoolId}/forms/${formId}`}
              className="inline-flex items-center gap-1 rounded border border-amber-400 bg-white px-2 py-1 text-amber-900 hover:bg-amber-100"
            >
              <Edit3 className="h-3 w-3" /> Back to editor
            </Link>
            <Link
              href={`/admin/${schoolId}/forms`}
              className="inline-flex items-center gap-1 text-amber-800 hover:underline"
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

        <FormPreviewRenderer schema={form.field_schema} />

        {/* Disabled submit — operator preview never submits */}
        <div className="mt-6 flex items-center gap-3 border-t border-zinc-200 pt-4">
          <button
            type="button"
            disabled
            className="rounded-md px-4 py-2 text-sm font-semibold text-white opacity-60 cursor-not-allowed"
            style={{ background: '#047857' }}
          >
            {form.payment_config ? 'Continue to payment' : 'Submit form'}
          </button>
          <span className="text-xs text-zinc-500">
            Disabled in preview. Submissions only happen when a real parent fills this out.
          </span>
        </div>
      </div>
    </main>
  );
}
