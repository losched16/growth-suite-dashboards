// /school/[locationId]/teacher-forms?from=classroom-N
//
// Teacher-facing FORM SUBMISSIONS view (Sonia: "Form Submissions
// section where they get access to the forms that are relevant to
// them — a subset of the portal forms hub"). Shows the classroom's
// students' submitted portal forms (med forms, consents, permissions),
// grouped by form, each expandable to the full answers and printable
// (print CSS keeps only expanded submissions).
//
// Scope: from=classroom-N narrows to that classroom's students; without
// a classroom context it shows the whole school (office use). Same
// URL-trust auth model as every /school teacher page.

import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { query } from '@/lib/db';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { ClassroomTopNav } from '@/components/ClassroomTopNav';
import { PrintButton } from '@/lib/widgets/components/_shared/PrintButton';
import { getTeacherIdentity } from '@/lib/auth/teacher-identity';
import { getStaffDirectory } from '@/lib/auth/staff-directory';
import { IdentityPicker } from '../staff-requests/IdentityPicker';
import { IdentityIndicator } from '../staff-requests/IdentityIndicator';

export const dynamic = 'force-dynamic';

type Params = Promise<{ locationId: string }>;
type SearchParams = Promise<{ from?: string; form?: string; mine?: string }>;

function isClassroomSlug(s: string | undefined): boolean {
  return !!s && /^(classroom-|program-)[a-z0-9-]+$/.test(s);
}
function prettyClassroom(slug: string): string {
  const stripped = slug.replace(/^(classroom-|program-)/, '');
  return slug.startsWith('classroom-')
    ? `Classroom ${stripped}`
    : stripped.toUpperCase().replace(/-/g, ' ');
}

interface SubRow {
  submission_id: string;
  form_id: string;
  form_name: string;
  field_schema: Array<{ key?: string; label?: string; type?: string }>;
  student_name: string;
  classroom: string | null;
  submitted_at: string;
  responses: Record<string, unknown>;
}

const DISPLAY_ONLY = new Set(['header', 'paragraph', 'section', 'signature_stamp']);

function fmtVal(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return v.map(String).join(', ');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// The roster filter must match students.metadata homeroom EXACTLY, and
// slugs don't always round-trip ("classroom-suite-100" → "Suite 100",
// not "Classroom suite-100"). The hub's own roster widget already
// carries the ground-truth label in default_homeroom_filter — read it.
async function homeroomLabelForSlug(schoolId: string, slug: string): Promise<string | null> {
  const { rows } = await query<{ layout: unknown }>(
    `SELECT layout FROM school_dashboards WHERE school_id = $1 AND dashboard_slug = $2`,
    [schoolId, slug],
  );
  const widgets = rows[0]?.layout;
  if (Array.isArray(widgets)) {
    for (const w of widgets) {
      const label = (w as { widget_id?: string; config?: { default_homeroom_filter?: string } })
        ?.config?.default_homeroom_filter;
      if (typeof label === 'string' && label.trim() !== '') return label.trim();
    }
  }
  return null;
}

export default async function TeacherFormsPage({
  params, searchParams,
}: { params: Params; searchParams: SearchParams }) {
  const { locationId } = await params;
  const sp = await searchParams;
  const classroomSlug = isClassroomSlug(sp.from) ? sp.from! : null;

  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) notFound();

  const classroomLabel = classroomSlug
    ? (await homeroomLabelForSlug(school.id, classroomSlug)) ?? prettyClassroom(classroomSlug)
    : null;

  // ?form=slug[,slug] narrows to specific forms — a direct share link.
  let formSlugs = (sp.form ?? '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter((x) => /^[a-z0-9-]+$/.test(x));

  // ?mine=1 — the SCALABLE auxiliary-staff mode (Sonia, 8/26 call:
  // "if we specify who gets notified, the form is accessible to those
  // staff members"). One permanent link for everyone: the visitor picks
  // their name once (same identity cookie as Staff Forms), and they see
  // submissions for every form whose NOTIFY list carries their email.
  // Access management = the office's existing Notify editor on each
  // form — no per-person links, no new admin screens.
  const mineMode = sp.mine === '1' && !classroomSlug;
  const thisUrl = `/school/${locationId}/teacher-forms?chrome=none&mine=1`;
  let identity: { email: string; name: string | null } | null = null;
  if (mineMode) {
    identity = await getTeacherIdentity();
    if (!identity) {
      const staff = await getStaffDirectory(school.id);
      return (
        <main className="min-h-screen bg-slate-50">
          <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6">
            <h1 className="text-xl font-bold text-slate-900 mb-1">Form Submissions</h1>
            <p className="text-sm text-slate-600 mb-4">
              Pick your name to see the forms the office has shared with you.
            </p>
            <IdentityPicker staff={staff} returnTo={thisUrl} />
          </div>
        </main>
      );
    }
    // No is_active filter: staff review submissions of UNPUBLISHED forms
    // too — the office pulls a form down when the window closes, and
    // that's precisely when SST reads the responses (Staying Safe).
    const { rows: granted } = await query<{ slug: string }>(
      `SELECT slug FROM portal_form_definitions
        WHERE school_id = $1
          AND audience IS DISTINCT FROM 'staff'
          AND EXISTS (SELECT 1 FROM unnest(COALESCE(notify_emails, '{}')) e
                       WHERE lower(e) = lower($2))
        ORDER BY display_name`,
      [school.id, identity.email],
    );
    formSlugs = granted.map((r) => r.slug);
    if (formSlugs.length === 0) {
      return (
        <main className="min-h-screen bg-slate-50">
          <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6">
            <h1 className="text-xl font-bold text-slate-900 mb-1">Form Submissions</h1>
            <div className="mt-3 flex items-center gap-3">
              <IdentityIndicator email={identity.email} name={identity.name} returnTo={thisUrl} />
            </div>
            <div className="mt-4 rounded-lg border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
              No forms are shared with you yet. Ask the office to add your email to the
              form&rsquo;s <strong>Notify</strong> list (Forms &amp; enrollment &rarr; the form&rsquo;s
              row) — it appears here automatically.
            </div>
          </div>
        </main>
      );
    }
  }

  const { rows } = await query<SubRow>(
    `SELECT s.id AS submission_id,
            d.id AS form_id, d.display_name AS form_name, d.field_schema,
            CONCAT_WS(' ', COALESCE(NULLIF(st.preferred_name, ''), st.first_name), st.last_name) AS student_name,
            COALESCE(NULLIF(st.metadata->>'homeroom',''), st.metadata->>'classroom_name') AS classroom,
            to_char(s.submitted_at AT TIME ZONE 'America/Phoenix', 'Mon DD, YYYY') AS submitted_at,
            s.responses
       FROM portal_form_submissions s
       JOIN portal_form_definitions d ON d.id = s.form_definition_id
       JOIN students st ON st.id = s.student_id
      WHERE s.school_id = $1
        AND st.status = 'active'
        AND (st.metadata->>'is_demo') IS DISTINCT FROM 'true'
        AND s.status IN ('submitted', 'paid', 'pending_payment', 'legacy_imported')
        AND COALESCE(s.is_test, false) = false
        AND d.audience IS DISTINCT FROM 'staff'
        AND ($2::text IS NULL
             OR COALESCE(NULLIF(st.metadata->>'homeroom',''), st.metadata->>'classroom_name') = $2)
        AND (cardinality($3::text[]) = 0 OR d.slug = ANY($3::text[]))
      ORDER BY d.display_name, student_name, s.submitted_at DESC`,
    [school.id, classroomLabel, formSlugs],
  );

  // Group by form; keep only the NEWEST submission per (form, student).
  const byForm = new Map<string, { name: string; subs: SubRow[] }>();
  const seen = new Set<string>();
  for (const r of rows) {
    const k = `${r.form_id}|${r.student_name}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (!byForm.has(r.form_id)) byForm.set(r.form_id, { name: r.form_name, subs: [] });
    byForm.get(r.form_id)!.subs.push(r);
  }

  return (
    <main className="min-h-screen bg-slate-50 print:bg-white">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 sm:py-6">
        {mineMode ? null : (
          <ClassroomTopNav
            locationId={locationId}
            classroomSlug={classroomSlug}
            classroomLabel={classroomLabel}
            active="forms"
          />
        )}

        <div className="flex flex-wrap items-baseline justify-between gap-3 mb-4">
          <div>
            <h1 className="text-xl font-bold text-slate-900">Form Submissions</h1>
            <p className="text-sm text-slate-600">
              {classroomLabel ? `${classroomLabel} — ` : ''}
              {mineMode ? 'the forms the office has shared with you, across all classrooms. '
                : formSlugs.length > 0 ? 'submissions for the selected form(s). '
                : 'your students’ submitted forms. '}
              Click a student to see their answers; use Print for a paper copy (only opened
              submissions print).
            </p>
            {mineMode && identity ? (
              <div className="mt-2">
                <IdentityIndicator email={identity.email} name={identity.name} returnTo={thisUrl} />
              </div>
            ) : null}
          </div>
          <PrintButton label="Print" />
        </div>

        {byForm.size === 0 ? (
          <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
            No submitted forms yet{classroomLabel ? ` for ${classroomLabel}` : ''}.
          </div>
        ) : (
          <div className="space-y-5">
            {[...byForm.values()].map((g) => (
              <section key={g.name} className="rounded-lg border border-slate-200 bg-white print:border-0">
                <h2 className="border-b border-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-900 print:border-b-2 print:border-slate-300">
                  {g.name} <span className="ml-1 font-normal text-slate-400">({g.subs.length})</span>
                </h2>
                <ul className="divide-y divide-slate-100">
                  {g.subs.map((sub) => {
                    const answerable = (Array.isArray(sub.field_schema) ? sub.field_schema : [])
                      .filter((b) => b && typeof b.key === 'string' && b.key && !DISPLAY_ONLY.has(String(b.type ?? '')));
                    return (
                      <li key={sub.submission_id}>
                        <details className="group">
                          <summary className="flex cursor-pointer items-baseline justify-between gap-3 px-4 py-2 text-sm hover:bg-slate-50 print:hidden">
                            <span className="font-medium text-slate-800">{sub.student_name}</span>
                            <span className="text-xs text-slate-500">
                              {sub.classroom ? `${sub.classroom} · ` : ''}{sub.submitted_at}
                            </span>
                          </summary>
                          <div className="px-4 pb-3 print:break-inside-avoid">
                            <div className="hidden print:block pt-2 text-sm font-semibold">
                              {sub.student_name} — {sub.submitted_at}
                            </div>
                            <dl className="mt-1 grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
                              {answerable.map((b) => (
                                <div key={String(b.key)} className="text-xs">
                                  <dt className="text-slate-500">{b.label ?? b.key}</dt>
                                  <dd className="text-slate-900 whitespace-pre-wrap">{fmtVal(sub.responses?.[String(b.key)])}</dd>
                                </div>
                              ))}
                            </dl>
                          </div>
                        </details>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
