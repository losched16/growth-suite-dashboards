// /school/[locationId]/families/[familyId]/forms
//
// Per-family form-submission dashboard for the school admin. Shows
// EVERY form this family has submitted (family-level + every student
// in the family), grouped by form, newest first, with a one-click
// drill-down into the submission detail (signature + responses).
//
// Wooster admin hits this from the Portal Forms Inbox by clicking
// "View all from this family" on a row.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, FileText, Eye, Printer, CheckCircle2 } from 'lucide-react';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { query } from '@/lib/db';
import { deriveEmbedToken } from '@/lib/auth/embed';

export const dynamic = 'force-dynamic';

type Params = Promise<{ locationId: string; familyId: string }>;

interface FamilyRow {
  id: string;
  display_name: string | null;
  notes: string | null;
}

interface ParentRow {
  id: string; first_name: string; last_name: string;
  email: string | null; phone: string | null; is_primary: boolean;
}

interface StudentRow {
  id: string; first_name: string; last_name: string; preferred_name: string | null;
}

interface SubmissionRow {
  id: string;
  form_id: string;
  form_slug: string;
  form_display_name: string;
  form_category: string | null;
  student_id: string | null;
  student_display: string | null;
  submitted_at: string;
  status: string;
  is_test: boolean;
  submitted_by_first: string | null;
  submitted_by_last: string | null;
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

export default async function FamilyFormsPage({
  params,
}: { params: Params }) {
  const { locationId, familyId } = await params;

  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();

  // Re-derive the embed_token so the "View as parent" button works
  // when opened in a new tab (where partitioned iframe cookies don't
  // attach). Same HMAC the iframe itself uses on first load.
  const viewAsParentHref =
    `/api/school/family/${familyId}/view-as-parent?embed_token=${encodeURIComponent(deriveEmbedToken(school.ghl_location_id))}`;

  // Family — scope to this school's families only.
  const { rows: familyRows } = await query<FamilyRow>(
    `SELECT id, display_name, notes
       FROM families
      WHERE id = $1 AND school_id = $2`,
    [familyId, school.id],
  );
  if (familyRows.length === 0) notFound();
  const family = familyRows[0];

  const { rows: parents } = await query<ParentRow>(
    `SELECT id, first_name, last_name, email, phone, is_primary
       FROM parents
      WHERE family_id = $1 AND school_id = $2 AND status = 'active'
      ORDER BY is_primary DESC, last_name, first_name`,
    [familyId, school.id],
  );

  const { rows: students } = await query<StudentRow>(
    `SELECT id, first_name, last_name, preferred_name
       FROM students
      WHERE family_id = $1 AND school_id = $2 AND status = 'active'
      ORDER BY first_name`,
    [familyId, school.id],
  );

  const studentLabel = (s: StudentRow) =>
    `${(s.preferred_name?.trim() || s.first_name)} ${s.last_name}`.trim();
  const studentLookup = new Map(students.map((s) => [s.id, studentLabel(s)]));

  // Every submission tied to this family — family-level forms (family_id
  // match) AND per-student forms (any student in the family).
  const { rows: submissions } = await query<SubmissionRow>(
    `SELECT s.id,
            d.id AS form_id,
            d.slug AS form_slug,
            d.display_name AS form_display_name,
            d.category AS form_category,
            s.student_id,
            CASE WHEN s.student_id IS NOT NULL THEN
              (SELECT COALESCE(NULLIF(st.preferred_name, ''), st.first_name) || ' ' || st.last_name
                 FROM students st WHERE st.id = s.student_id)
              ELSE NULL END AS student_display,
            to_char(s.submitted_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS submitted_at,
            COALESCE(s.status, 'submitted') AS status,
            COALESCE(s.is_test, false) AS is_test,
            (SELECT first_name FROM parents WHERE id = s.parent_id) AS submitted_by_first,
            (SELECT last_name FROM parents WHERE id = s.parent_id) AS submitted_by_last
       FROM portal_form_submissions s
       JOIN portal_form_definitions d ON d.id = s.form_definition_id
      WHERE s.school_id = $1
        AND COALESCE(d.audience, 'parents') = 'parents'
        AND (
          s.family_id = $2
          OR s.student_id IN (SELECT id FROM students WHERE family_id = $2 AND school_id = $1)
        )
      ORDER BY s.submitted_at DESC NULLS LAST`,
    [school.id, familyId],
  );

  // Group by form (for the "what have they submitted" summary at top)
  const byForm = new Map<string, { displayName: string; slug: string; category: string | null; count: number }>();
  for (const s of submissions) {
    if (s.is_test) continue;
    const ex = byForm.get(s.form_id);
    if (ex) ex.count++;
    else byForm.set(s.form_id, {
      displayName: s.form_display_name,
      slug: s.form_slug,
      category: s.form_category,
      count: 1,
    });
  }
  const formGroups = Array.from(byForm.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));

  // Distinct list of forms this family has NOT submitted (for "still needed" panel)
  const { rows: requiredForms } = await query<{ id: string; slug: string; display_name: string }>(
    `SELECT id, slug, display_name FROM portal_form_definitions
      WHERE school_id = $1 AND is_active = true AND COALESCE(audience,'parents')='parents'
      ORDER BY display_name`,
    [school.id],
  );
  const submittedFormIds = new Set(Array.from(byForm.keys()));
  const stillNeeded = requiredForms.filter((f) => !submittedFormIds.has(f.id));

  const familyName = family.display_name || `${parents[0]?.last_name ?? 'Family'} Family`;

  return (
    <main className="min-h-screen bg-slate-50 print:bg-white">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 sm:py-6">
        <Link
          href={`/school/${locationId}/portal-forms?chrome=none`}
          className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 mb-3 print:hidden"
        >
          <ArrowLeft className="h-3 w-3" /> Back to Portal Forms
        </Link>

        <header className="mb-5">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h1 className="text-2xl font-semibold text-slate-900">{familyName} — submitted forms</h1>
              <p className="text-sm text-slate-500 mt-0.5">
                {parents.length} parent{parents.length === 1 ? '' : 's'} · {students.length} student{students.length === 1 ? '' : 's'} ·{' '}
                {submissions.filter((s) => !s.is_test).length} submission{submissions.filter((s) => !s.is_test).length === 1 ? '' : 's'}
              </p>
            </div>
            <a
              href={viewAsParentHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-blue-300 bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-800 hover:bg-blue-100 print:hidden"
              title="Sign in as this family's primary parent. Verify prefill and see what they see."
            >
              👤 View as parent
            </a>
          </div>
          {parents.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-600">
              {parents.map((p) => (
                <span key={p.id}>
                  <strong>{p.first_name} {p.last_name}</strong>
                  {p.email ? <span className="text-slate-500"> · {p.email}</span> : null}
                  {p.is_primary ? <span className="ml-1 rounded bg-emerald-100 px-1 py-0 text-[9px] font-bold uppercase text-emerald-800">primary</span> : null}
                </span>
              ))}
            </div>
          ) : null}
          {students.length > 0 ? (
            <div className="mt-1 text-xs text-slate-600">
              <strong>Students:</strong>{' '}
              {students.map((s) => studentLabel(s)).join(' · ')}
            </div>
          ) : null}
        </header>

        {/* Summary strip */}
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
          <SummaryCard label="Distinct forms submitted" value={formGroups.length} />
          <SummaryCard label="Total submissions" value={submissions.filter((s) => !s.is_test).length} />
          <SummaryCard label="Forms still needed" value={stillNeeded.length} tone={stillNeeded.length > 0 ? 'amber' : 'emerald'} />
          <SummaryCard label="Most recent submission" value={submissions[0] ? fmtDateTime(submissions[0].submitted_at).split(',')[0] : '—'} />
        </section>

        {/* Forms still needed (compact list) */}
        {stillNeeded.length > 0 ? (
          <section className="mb-5 rounded-lg border border-amber-200 bg-amber-50/40 p-3">
            <h2 className="text-sm font-semibold text-amber-900 mb-1.5">Still needed ({stillNeeded.length})</h2>
            <ul className="flex flex-wrap gap-1.5">
              {stillNeeded.map((f) => (
                <li key={f.id}>
                  <span className="inline-block rounded-full bg-white border border-amber-300 text-amber-900 px-2 py-0.5 text-[11px]">
                    {f.display_name}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <section className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50/40 p-3 flex items-center gap-2 text-emerald-900 text-sm">
            <CheckCircle2 className="h-4 w-4" />
            All required forms submitted.
          </section>
        )}

        {/* Submissions list — one row per (form, student/family). Older
            resubmissions and addendums collapse into an "updated N times"
            badge on the latest row. Joe's framing: he wants to see the
            single canonical submission per form, not a stack of test
            edits and amendments. */}
        <section className="space-y-3">
          {submissions.length === 0 ? (
            <div className="rounded-lg border-2 border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500 italic">
              No form submissions on file for this family yet.
            </div>
          ) : (
            formGroups.map((g) => {
              // Within this form, group every submission by the slot it
              // belongs to (one kid, or the whole family for family-level
              // forms). Take the newest as the canonical row; the rest
              // collapse into an "updated N more times" badge.
              const formSubs = submissions
                .filter((s) => s.form_slug === g.slug && !s.is_test);
              const slotMap = new Map<string, SubmissionRow[]>();
              for (const s of formSubs) {
                const slot = s.student_id ?? 'family';
                const list = slotMap.get(slot) ?? [];
                list.push(s);
                slotMap.set(slot, list);
              }
              // Each slot's list is already ordered newest-first via the
              // SQL ORDER BY. The latest IS the canonical row.
              const rows = Array.from(slotMap.values()).map((list) => ({
                canonical: list[0],
                history: list.slice(1),
              }));
              // Stable display order: family-level first, then by kid name.
              rows.sort((a, b) => {
                const aFam = !a.canonical.student_display;
                const bFam = !b.canonical.student_display;
                if (aFam !== bFam) return aFam ? -1 : 1;
                return (a.canonical.student_display ?? '').localeCompare(b.canonical.student_display ?? '');
              });

              return (
                <div key={g.slug} className="rounded-lg border border-slate-200 bg-white overflow-hidden">
                  <header className="border-b border-slate-100 bg-slate-50 px-4 py-2 flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-2">
                      <FileText className="h-4 w-4 text-slate-500" />
                      <h3 className="text-sm font-semibold text-slate-900">{g.displayName}</h3>
                      {g.category ? (
                        <span className="rounded-full bg-slate-100 text-slate-600 px-1.5 py-0 text-[10px] uppercase tracking-wide">{g.category}</span>
                      ) : null}
                    </div>
                  </header>
                  <ul className="divide-y divide-slate-100">
                    {rows.map(({ canonical: s, history }) => (
                      <li key={s.id} className="px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
                        <div className="text-sm flex-1 min-w-0">
                          {s.student_display ? (
                            <span className="font-medium text-slate-900">{s.student_display}</span>
                          ) : (
                            <span className="font-medium text-slate-900">Family</span>
                          )}
                          <span className="text-slate-500"> · submitted {fmtDateTime(s.submitted_at)}</span>
                          {s.submitted_by_first ? (
                            <span className="text-slate-500"> · by {s.submitted_by_first} {s.submitted_by_last ?? ''}</span>
                          ) : null}
                          {history.length > 0 ? (
                            <span
                              className="ml-2 inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-800 px-1.5 py-0.5 text-[10px] font-medium"
                              title={`Earlier versions:\n${history.map((h) => fmtDateTime(h.submitted_at)).join('\n')}`}
                            >
                              ✎ updated {history.length} more time{history.length === 1 ? '' : 's'}
                            </span>
                          ) : null}
                          {s.status === 'legacy_imported' ? (
                            <span className="ml-2 inline-block rounded-full bg-blue-100 text-blue-800 px-1.5 py-0 text-[10px] font-medium">
                              imported from previous system
                            </span>
                          ) : null}
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Link
                            href={`/school/${locationId}/forms/${s.form_id}/submissions/${s.id}?chrome=none`}
                            className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                          >
                            <Eye className="h-3.5 w-3.5" /> View
                          </Link>
                          <Link
                            href={`/school/${locationId}/forms/${s.form_id}/submissions/${s.id}?chrome=none&print=1`}
                            className="inline-flex items-center gap-1 rounded-md border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
                            title="Open the print dialog — choose 'Save as PDF' from the destination dropdown to download"
                          >
                            <Printer className="h-3.5 w-3.5" /> Print / PDF
                          </Link>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })
          )}
        </section>
      </div>
    </main>
  );
}

function SummaryCard({ label, value, tone = 'slate' }: { label: string; value: number | string; tone?: 'slate' | 'amber' | 'emerald' }) {
  const cfg = tone === 'amber'
    ? 'border-amber-200 bg-amber-50/40'
    : tone === 'emerald'
      ? 'border-emerald-200 bg-emerald-50/40'
      : 'border-slate-200 bg-white';
  return (
    <div className={`rounded-lg border ${cfg} p-3`}>
      <div className="text-[11px] uppercase tracking-wide text-slate-500 font-medium">{label}</div>
      <div className="text-2xl font-semibold text-slate-900 tabular-nums mt-0.5">{value}</div>
    </div>
  );
}
