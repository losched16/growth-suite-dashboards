// /school/[locationId]/forms/[formId]/print-all[?classroom=…]
//
// Bulk print: every enrolled student's latest submission of one form, one
// per page (per-family forms: one page per family, siblings listed), so the
// office can print or "Save as PDF" a whole school or one classroom in one
// go instead of opening each submission. A cover page lists who hasn't
// submitted. Answers come from lib/forms/student-report (latest submission,
// amendments applied, earlier-form imports included).

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { query } from '@/lib/db';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { buildStudentReport, formatAnswer, type ReportRow } from '@/lib/forms/student-report';
import { AutoSubmitForm } from '@/lib/widgets/components/_shared/AutoSubmitForm';
import { PreserveEmbedParams } from '@/lib/widgets/components/_shared/PreserveEmbedParams';
import { PrintButton } from '@/lib/widgets/components/_shared/PrintButton';

export const dynamic = 'force-dynamic';

type Params = Promise<{ locationId: string; formId: string }>;
type SearchParams = Promise<Record<string, string | undefined>>;

export default async function PrintAllSubmissions({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { locationId, formId } = await params;
  const sp = await searchParams;
  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();

  const classroom = sp.classroom?.trim() || null;
  const report = await buildStudentReport({ schoolId: school.id, formIds: [formId], classroom });
  const form = report.forms[0];
  if (!form) notFound();
  const allClassrooms = classroom
    ? (await buildStudentReport({ schoolId: school.id, formIds: [formId] })).rows.map((r) => r.classroom)
    : report.rows.map((r) => r.classroom);
  const classrooms = [...new Set(allClassrooms.filter(Boolean))].sort();

  // One printed entry per submission: per-family forms group siblings.
  const entries = new Map<string, ReportRow[]>();
  const missing: ReportRow[] = [];
  for (const r of report.rows) {
    const sid = r.submissionId[form.id];
    if (!sid) { missing.push(r); continue; }
    (entries.get(sid) ?? entries.set(sid, []).get(sid)!).push(r);
  }

  // Signature line (kept out of the report columns on purpose).
  const sigIds = [...entries.keys()];
  const { rows: sigRows } = sigIds.length
    ? await query<{ id: string; sig: unknown; signed: string | null }>(
        `SELECT id, COALESCE(responses->'parent_signature', responses->'signature') AS sig,
                COALESCE(responses->>'signature_date', to_char(submitted_at, 'YYYY-MM-DD')) AS signed
           FROM portal_form_submissions WHERE id = ANY($1::uuid[])`, [sigIds])
    : { rows: [] as Array<{ id: string; sig: unknown; signed: string | null }> };
  const sigs = new Map(sigRows.map((s) => [s.id, s]));
  const cols = report.columns.filter((c) => c.formId === form.id);

  return (
    <main className="mx-auto max-w-4xl px-4 py-6 print:max-w-none print:p-0">
      <style>{`@media print { .entry { break-after: page; page-break-after: always; } .entry:last-child { break-after: auto; } @page { margin: 12mm; } }`}</style>

      <div className="print:hidden mb-5 space-y-3">
        <Link href={`/school/${locationId}/forms/${formId}/submissions`} className="text-xs text-slate-500 hover:text-slate-700 inline-flex items-center gap-1">
          <ArrowLeft className="h-3 w-3" /> Back to submissions
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">Print all — {form.name}</h1>
            <p className="text-xs text-slate-500">
              {entries.size} {form.perStudent ? 'student' : 'family'} submission{entries.size === 1 ? '' : 's'}
              {classroom ? ` · ${classroom}` : ' · whole school'} · {missing.length} student{missing.length === 1 ? '' : 's'} not submitted
              {' '}· each prints on its own page (use “Save as PDF” in the print dialog for a file)
            </p>
          </div>
          <div className="flex items-center gap-2">
            <AutoSubmitForm className="flex items-center gap-2">
              <PreserveEmbedParams current={sp} />
              <select name="classroom" defaultValue={classroom ?? ''} className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs">
                <option value="">All classrooms</option>
                {classrooms.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <noscript><button type="submit" className="rounded-md border px-2 py-1 text-xs">Apply</button></noscript>
            </AutoSubmitForm>
            <PrintButton label="Print / Save as PDF" title="Print every submission shown below, one per page" />
          </div>
        </div>
      </div>

      {missing.length > 0 ? (
        <section className="entry mb-8 rounded-lg border border-slate-200 bg-white p-5 print:border-0 print:p-0">
          <h2 className="text-lg font-semibold text-slate-900">{form.name} — not yet submitted</h2>
          <p className="text-xs text-slate-500">{school.name}{classroom ? ` · ${classroom}` : ''} · {missing.length} student{missing.length === 1 ? '' : 's'}</p>
          <table className="mt-3 w-full text-xs">
            <thead><tr className="text-left text-slate-500"><th className="py-1 pr-3">Student</th><th className="py-1 pr-3">Classroom</th><th className="py-1 pr-3">Parent</th><th className="py-1">Email</th></tr></thead>
            <tbody>
              {missing.map((r) => (
                <tr key={r.studentId} className="border-t border-slate-100">
                  <td className="py-1 pr-3 font-medium text-slate-900">{r.student}</td>
                  <td className="py-1 pr-3">{r.classroom}</td>
                  <td className="py-1 pr-3">{r.parentName}</td>
                  <td className="py-1">{r.parentEmail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {[...entries.entries()].map(([sid, kids]) => {
        const r = kids[0];
        const sig = sigs.get(sid);
        const answered = cols.filter((c) => (r.values[c.id] ?? '') !== '');
        return (
          <section key={sid} className="entry mb-8 rounded-lg border border-slate-200 bg-white p-5 print:border-0 print:p-0">
            <header className="border-b border-slate-200 pb-2">
              <p className="text-[10px] uppercase tracking-wide text-slate-500">{school.name} · {form.name}</p>
              <h2 className="text-lg font-semibold text-slate-900">
                {kids.map((k) => k.student).join(', ')}
              </h2>
              <p className="text-xs text-slate-600">
                {[...new Set(kids.map((k) => k.classroom).filter(Boolean))].join(', ')}
                {r.family ? ` · ${r.family}` : ''}
                {r.parentName ? ` · ${r.parentName}` : ''}{r.parentEmail ? ` (${r.parentEmail})` : ''}
                {` · submitted ${r.submittedOn[form.id]}`}
                {r.source[form.id] === 'Earlier form (imported)' ? ' (earlier form — only the questions it asked are shown)' : ''}
              </p>
            </header>
            <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2 print:grid-cols-2">
              {answered.map((c) => (
                <div key={c.id} className="break-inside-avoid">
                  <dt className="font-medium text-slate-500">{c.label}</dt>
                  <dd className="text-slate-900 whitespace-pre-wrap">{r.values[c.id]}</dd>
                </div>
              ))}
            </dl>
            {answered.length === 0 ? <p className="mt-3 text-xs italic text-slate-500">No answers recorded on this submission.</p> : null}
            {sig && formatAnswer(sig.sig) ? (
              <p className="mt-4 border-t border-slate-200 pt-2 text-xs text-slate-700">
                Signed: <span className="font-medium">{formatAnswer(sig.sig)}</span>{sig.signed ? ` · ${sig.signed}` : ''}
              </p>
            ) : null}
          </section>
        );
      })}

      {entries.size === 0 && missing.length === 0 ? (
        <p className="text-sm text-slate-500">No students in this view.</p>
      ) : null}
    </main>
  );
}
