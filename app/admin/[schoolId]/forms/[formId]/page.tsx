// /admin/[schoolId]/forms/[formId] — edit a single form definition.
//
// Server-renders the current form state and hands off to a client
// component that lets the operator edit display_name, description,
// toggles, and the field_schema (label, type, required, help, options,
// amounts). Saves with a single PATCH back to the API.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { query } from '@/lib/db';
import { FormEditor } from './FormEditor';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type Params = Promise<{ schoolId: string; formId: string }>;
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
}

const PARENT_PORTAL_BASE = process.env.PARENT_PORTAL_BASE_URL
  ?? 'https://growth-suite-parent-portal.vercel.app';

export default async function FormEditPage({
  params, searchParams,
}: { params: Params; searchParams: SearchParams }) {
  const { schoolId, formId } = await params;
  const sp = await searchParams;

  const { rows } = await query<FormDefRow>(
    `SELECT id, slug, display_name, description, category, per_student,
            is_active, allow_addendum, needs_review, resubmission_allowed,
            one_submission_per_year, field_schema,
            confirmation_message, confirmation_redirect_url, notify_emails
       FROM portal_form_definitions
      WHERE id = $1 AND school_id = $2`,
    [formId, schoolId],
  );
  if (rows.length === 0) notFound();
  const form = rows[0];

  return (
    <main className="flex flex-1 flex-col items-center bg-zinc-50 p-6">
      <div className="w-full max-w-4xl space-y-4">
        <Link href={`/admin/${schoolId}/forms`} className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-700">
          <ArrowLeft className="h-3 w-3" /> All forms
        </Link>

        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-900">Edit form</h1>
            <div className="text-xs text-zinc-500 font-mono">{form.slug}</div>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href={`/admin/${schoolId}/forms/${form.id}/preview`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-emerald-300 bg-white px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50"
              title="Standalone preview — no parent login needed"
            >
              <ExternalLink className="h-3 w-3" /> Preview
            </Link>
            <a
              href={`${PARENT_PORTAL_BASE}/forms-v2/${form.slug}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:underline"
              title="Open the live parent-portal URL (requires parent login)"
            >
              live ↗
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
          schoolId={schoolId}
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
          }}
        />
      </div>
    </main>
  );
}
