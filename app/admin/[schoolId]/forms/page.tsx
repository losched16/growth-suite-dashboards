// /admin/[schoolId]/forms — list of all portal form definitions for
// the school. Surfaces is_active / allow_addendum toggles + counts of
// fields and submissions, with deep-links to (a) edit the form schema
// and (b) preview as a parent.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, FileText, Eye, Edit3 } from 'lucide-react';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type Params = Promise<{ schoolId: string }>;
type SearchParams = Promise<{ msg?: string; err?: string }>;

interface FormRow {
  id: string;
  slug: string;
  display_name: string;
  description: string | null;
  category: string | null;
  per_student: boolean;
  field_count: number;
  is_active: boolean;
  allow_addendum: boolean;
  needs_review: boolean;
  has_payment: boolean;
  submission_count: number;
}

const PARENT_PORTAL_BASE = process.env.PARENT_PORTAL_BASE_URL
  ?? 'https://growth-suite-parent-portal.vercel.app';

export default async function FormsListPage({
  params, searchParams,
}: { params: Params; searchParams: SearchParams }) {
  const { schoolId } = await params;
  const sp = await searchParams;

  const { rows: schoolRows } = await query<{ id: string; name: string }>(
    `SELECT id, name FROM schools WHERE id = $1`, [schoolId],
  );
  if (schoolRows.length === 0) notFound();
  const school = schoolRows[0];

  const { rows: forms } = await query<FormRow>(
    `SELECT
       d.id, d.slug, d.display_name, d.description, d.category, d.per_student,
       jsonb_array_length(d.field_schema) AS field_count,
       d.is_active, d.allow_addendum, d.needs_review,
       (d.payment_config IS NOT NULL) AS has_payment,
       (SELECT COUNT(*)::int FROM portal_form_submissions s
         WHERE s.form_definition_id = d.id) AS submission_count
     FROM portal_form_definitions d
     WHERE d.school_id = $1
     ORDER BY d.is_active DESC, d.category NULLS LAST, d.display_name`,
    [schoolId],
  );

  const active = forms.filter((f) => f.is_active);
  const inactive = forms.filter((f) => !f.is_active);

  return (
    <main className="flex flex-1 flex-col items-center bg-zinc-50 p-6 dark:bg-black">
      <div className="w-full max-w-5xl space-y-4">
        <Link href={`/admin/${schoolId}`} className="text-xs text-zinc-500 hover:text-zinc-700">
          ← {school.name}
        </Link>
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-900">Forms</h1>
            <p className="text-xs text-zinc-500">
              {school.name} · {active.length} active, {inactive.length} inactive
            </p>
          </div>
        </div>

        {sp.msg ? (
          <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{sp.msg}</div>
        ) : null}
        {sp.err ? (
          <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{sp.err}</div>
        ) : null}

        <FormsTable schoolId={schoolId} title="Active forms" forms={active} />
        {inactive.length > 0 ? (
          <FormsTable schoolId={schoolId} title="Inactive forms" forms={inactive} muted />
        ) : null}
      </div>
    </main>
  );
}

function FormsTable({
  schoolId, title, forms, muted,
}: { schoolId: string; title: string; forms: FormRow[]; muted?: boolean }) {
  if (forms.length === 0) return null;
  return (
    <section className="rounded-xl border border-black/10 bg-white overflow-hidden">
      <div className="border-b border-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-700">
        {title} ({forms.length})
      </div>
      <table className="w-full text-sm">
        <thead className="bg-zinc-50 border-b border-zinc-100 text-left text-[10px] uppercase tracking-wide text-zinc-500">
          <tr>
            <th className="px-3 py-2 font-medium">Form</th>
            <th className="px-3 py-2 font-medium">Category</th>
            <th className="px-3 py-2 font-medium text-right">Fields</th>
            <th className="px-3 py-2 font-medium text-right">Submissions</th>
            <th className="px-3 py-2 font-medium text-center">Flags</th>
            <th className="px-3 py-2 font-medium text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">
          {forms.map((f) => (
            <tr key={f.id} className={muted ? 'opacity-70' : ''}>
              <td className="px-3 py-2">
                <div className="font-medium text-zinc-900">{f.display_name}</div>
                <div className="text-[10px] text-zinc-500 font-mono">{f.slug}</div>
                {f.description ? (
                  <div className="text-[11px] text-zinc-600 truncate max-w-md">{f.description}</div>
                ) : null}
              </td>
              <td className="px-3 py-2 text-xs">
                {f.category ? (
                  <span className="rounded bg-zinc-100 px-1.5 py-0.5 uppercase tracking-wide text-zinc-600">
                    {f.category}
                  </span>
                ) : <span className="text-zinc-400">—</span>}
              </td>
              <td className="px-3 py-2 text-right text-sm font-mono">{f.field_count}</td>
              <td className="px-3 py-2 text-right text-sm font-mono">{f.submission_count}</td>
              <td className="px-3 py-2 text-center">
                <div className="flex items-center justify-center gap-1 flex-wrap">
                  {f.per_student ? <Pill bg="bg-blue-100" fg="text-blue-700">per-student</Pill> : null}
                  {f.has_payment ? <Pill bg="bg-emerald-100" fg="text-emerald-800">$ payment</Pill> : null}
                  {f.allow_addendum ? <Pill bg="bg-violet-100" fg="text-violet-800">addendum</Pill> : null}
                  {f.needs_review ? <Pill bg="bg-amber-100" fg="text-amber-800">needs review</Pill> : null}
                </div>
              </td>
              <td className="px-3 py-2 text-right whitespace-nowrap">
                <div className="inline-flex items-center gap-1">
                  <Link
                    href={`/admin/${schoolId}/forms/${f.id}`}
                    className="inline-flex items-center gap-1 rounded border border-emerald-300 bg-white px-2 py-1 text-[11px] font-medium text-emerald-700 hover:bg-emerald-50"
                  >
                    <Edit3 className="h-3 w-3" /> Edit
                  </Link>
                  <a
                    href={`${PARENT_PORTAL_BASE}/forms-v2/${f.slug}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded border border-zinc-300 bg-white px-2 py-1 text-[11px] text-zinc-700 hover:bg-zinc-50"
                  >
                    <Eye className="h-3 w-3" /> Preview
                  </a>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {forms.length === 0 ? (
        <div className="p-8 text-center text-zinc-500">
          <FileText className="mx-auto h-8 w-8 text-zinc-300 mb-2" />
          <p className="text-sm">No forms yet.</p>
        </div>
      ) : null}
    </section>
  );
}

function Pill({ children, bg, fg }: { children: React.ReactNode; bg: string; fg: string }) {
  return (
    <span className={`inline-block rounded-full ${bg} px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${fg}`}>
      {children}
    </span>
  );
}
