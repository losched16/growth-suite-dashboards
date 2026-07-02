// /school/[locationId]/forms/[formId]/submissions — school-scoped
// submissions inbox. Mirrors /admin/.../submissions but its back link
// stays inside the GHL-embedded iframe (no escape to /admin/...).
//
// Logic is identical to the /admin version; we resolve locationId →
// schoolId then run the same queries.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ChevronDown, Mail, Phone, Inbox, Users, FlaskConical, Trash2, Paperclip, Download, FileText, PencilLine } from 'lucide-react';
import { query } from '@/lib/db';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { HelpCallout } from '@/components/HelpCallout';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type Params = Promise<{ locationId: string; formId: string }>;
type SearchParams = Promise<{ open?: string; show_test?: string }>;

interface FormDef {
  id: string;
  slug: string;
  display_name: string;
  per_student: boolean;
  field_schema: Array<{ key?: string; label?: string; type?: string }>;
}

interface Submission {
  id: string;
  family_id: string | null;
  parent_id: string | null;
  student_id: string | null;
  status: string;
  submitted_at: string;
  responses: Record<string, unknown>;
  family_label: string;
  parent_email: string | null;
  parent_phone: string | null;
  student_label: string | null;
  is_test: boolean;
  is_addendum: boolean;
  parent_submission_id: string | null;
  parent_submitted_at: string | null;
  cosign_status: string | null;
}

interface MissingRecipient {
  family_id: string;
  family_label: string;
  parent_email: string | null;
  parent_phone: string | null;
  student_id: string | null;
  student_label: string | null;
}

interface FormUpload {
  id: string;
  display_name: string | null;
  original_filename: string;
  size_bytes: number;
  uploaded_at: string;
  acknowledged_at: string | null;
  family_label: string;
  student_label: string | null;
}

// Engagement badge for a not-yet-submitted family: did they open the form,
// or at least log in? Falls back to "never logged in".
function EngagementCell({
  familyId, viewedMap, loginMap,
}: { familyId: string; viewedMap: Map<string, string>; loginMap: Map<string, string> }) {
  const viewed = viewedMap.get(familyId);
  const login = loginMap.get(familyId);
  const fmt = (d: string) => new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (viewed) {
    return (
      <span title="Opened this form but hasn't submitted" className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-800">
        Opened {fmt(viewed)}
      </span>
    );
  }
  if (login) {
    return (
      <span title="Logged in but hasn't opened this form" className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700">
        Logged in {fmt(login)}
      </span>
    );
  }
  return (
    <span title="Hasn't logged into the portal" className="inline-flex items-center rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-medium text-rose-700">
      Never logged in
    </span>
  );
}

export default async function SubmissionsInboxScoped({
  params, searchParams,
}: { params: Params; searchParams: SearchParams }) {
  const { locationId, formId } = await params;
  const sp = await searchParams;
  const openId = sp.open ?? null;
  const showTest = sp.show_test === '1';

  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();
  const schoolId = school.id;

  const { rows: defRows } = await query<FormDef>(
    `SELECT id, slug, display_name, per_student, field_schema
       FROM portal_form_definitions
      WHERE id = $1 AND school_id = $2`,
    [formId, schoolId],
  );
  if (defRows.length === 0) notFound();
  const def = defRows[0];

  // Test submissions have NULL family_id (migration 041) so we need a
  // LEFT JOIN on families to include them when show_test=1. The
  // is_test filter is appended conditionally.
  const { rows: subs } = await query<Submission>(
    `SELECT s.id, s.family_id, s.parent_id, s.student_id, s.status,
            s.submitted_at, s.responses, s.is_test, s.cosign_status,
            COALESCE(s.is_addendum, false) AS is_addendum,
            s.parent_submission_id,
            ps.submitted_at AS parent_submitted_at,
            COALESCE(NULLIF(f.display_name, ''),
                     CONCAT_WS(' ', p.first_name, p.last_name),
                     CASE WHEN s.is_test THEN '(test submission)' ELSE '(unnamed family)' END) AS family_label,
            p.email AS parent_email,
            p.phone AS parent_phone,
            CASE WHEN st.id IS NOT NULL
                 THEN CONCAT_WS(' ', COALESCE(NULLIF(st.preferred_name, ''), st.first_name), st.last_name)
                 ELSE NULL END AS student_label
       FROM portal_form_submissions s
       LEFT JOIN families f ON f.id = s.family_id
       LEFT JOIN parents p ON p.id = s.parent_id
       LEFT JOIN students st ON st.id = s.student_id
       LEFT JOIN portal_form_submissions ps ON ps.id = s.parent_submission_id
      WHERE s.form_definition_id = $1
        AND s.status IN ('submitted', 'paid', 'pending_payment', 'legacy_imported')
        ${showTest ? '' : 'AND s.is_test = false'}
      ORDER BY s.submitted_at DESC
      LIMIT 500`,
    [formId],
  );

  // Counter for the "Show test submissions" toggle. Cheap.
  const { rows: testCountRows } = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM portal_form_submissions
      WHERE form_definition_id = $1 AND is_test = true`,
    [formId],
  );
  const testCount = testCountRows[0]?.n ?? 0;

  // Files parents uploaded FOR this form (parent_uploads.form_id). Separate
  // from the form answers above — staff see + download them right here.
  const { rows: uploads } = await query<FormUpload>(
    `SELECT u.id, u.display_name, u.original_filename, u.size_bytes,
            to_char(u.uploaded_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS uploaded_at,
            to_char(u.acknowledged_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS acknowledged_at,
            COALESCE(NULLIF(f.display_name, ''), '(unnamed family)') AS family_label,
            CASE WHEN u.student_id IS NOT NULL THEN
              (SELECT COALESCE(NULLIF(st.preferred_name,''), st.first_name) || ' ' || st.last_name
                 FROM students st WHERE st.id = u.student_id)
              ELSE NULL END AS student_label
       FROM parent_uploads u
       LEFT JOIN families f ON f.id = u.family_id
      WHERE u.school_id = $1 AND u.form_id = $2
      ORDER BY u.uploaded_at DESC
      LIMIT 500`,
    [schoolId, formId],
  );

  let missing: MissingRecipient[];
  if (def.per_student) {
    const { rows } = await query<MissingRecipient>(
      `WITH eligible AS (
         SELECT f.id AS family_id, st.id AS student_id,
                COALESCE(NULLIF(f.display_name, ''),
                         CONCAT_WS(' ', p.first_name, p.last_name),
                         '(unnamed family)') AS family_label,
                p.email AS parent_email,
                p.phone AS parent_phone,
                CONCAT_WS(' ', COALESCE(NULLIF(st.preferred_name, ''), st.first_name), st.last_name) AS student_label
           FROM families f
           JOIN students st ON st.family_id = f.id AND st.status = 'active'
           LEFT JOIN LATERAL (
             SELECT first_name, last_name, email, phone
               FROM parents
              WHERE family_id = f.id AND is_primary = true LIMIT 1
           ) p ON true
          WHERE f.school_id = $1
       )
       SELECT e.family_id, e.family_label, e.parent_email, e.parent_phone,
              e.student_id, e.student_label
         FROM eligible e
        WHERE NOT EXISTS (
           SELECT 1 FROM portal_form_submissions s
            WHERE s.form_definition_id = $2
              AND s.family_id = e.family_id
              AND s.student_id = e.student_id
              AND s.status IN ('submitted', 'paid', 'pending_payment', 'legacy_imported')
        )
        ORDER BY e.family_label, e.student_label
        LIMIT 500`,
      [schoolId, formId],
    );
    missing = rows;
  } else {
    const { rows } = await query<MissingRecipient>(
      `WITH eligible AS (
         SELECT DISTINCT f.id AS family_id,
                COALESCE(NULLIF(f.display_name, ''),
                         CONCAT_WS(' ', p.first_name, p.last_name),
                         '(unnamed family)') AS family_label,
                p.email AS parent_email,
                p.phone AS parent_phone
           FROM families f
           JOIN students st ON st.family_id = f.id AND st.status = 'active'
           LEFT JOIN LATERAL (
             SELECT first_name, last_name, email, phone
               FROM parents
              WHERE family_id = f.id AND is_primary = true LIMIT 1
           ) p ON true
          WHERE f.school_id = $1
       )
       SELECT e.family_id, e.family_label, e.parent_email, e.parent_phone,
              NULL::uuid AS student_id, NULL::text AS student_label
         FROM eligible e
        WHERE NOT EXISTS (
           SELECT 1 FROM portal_form_submissions s
            WHERE s.form_definition_id = $2
              AND s.family_id = e.family_id
              AND s.status IN ('submitted', 'paid', 'pending_payment', 'legacy_imported')
        )
        ORDER BY e.family_label
        LIMIT 500`,
      [schoolId, formId],
    );
    missing = rows;
  }

  // Engagement signals for the "not yet submitted" roster: has the family
  // logged in at all, and has anyone in it actually OPENED this form? Both
  // aggregated to the family (a family can have two logins). Lets the office
  // tell "resend a login invite" apart from "just nudge — they've seen it."
  const missingFamilyIds = Array.from(new Set(missing.map((m) => m.family_id).filter(Boolean)));
  const lastLoginByFamily = new Map<string, string>();
  const viewedByFamily = new Map<string, string>();
  if (missingFamilyIds.length > 0) {
    const { rows: loginRows } = await query<{ family_id: string; last_login: string }>(
      `SELECT p.family_id,
              to_char(MAX(ps.issued_at), 'YYYY-MM-DD"T"HH24:MI:SSOF') AS last_login
         FROM parent_sessions ps
         JOIN parents p ON p.id = ps.parent_id
        WHERE ps.school_id = $1 AND p.family_id = ANY($2::uuid[])
        GROUP BY p.family_id`,
      [schoolId, missingFamilyIds],
    );
    for (const r of loginRows) lastLoginByFamily.set(r.family_id, r.last_login);
    const { rows: viewRows } = await query<{ family_id: string; last_viewed: string }>(
      `SELECT family_id,
              to_char(MAX(last_viewed_at), 'YYYY-MM-DD"T"HH24:MI:SSOF') AS last_viewed
         FROM portal_form_views
        WHERE school_id = $1 AND form_definition_id = $2 AND family_id = ANY($3::uuid[])
        GROUP BY family_id`,
      [schoolId, formId, missingFamilyIds],
    );
    for (const r of viewRows) viewedByFamily.set(r.family_id, r.last_viewed);
  }

  // Completion math: test rows AND amendments should never inflate the real %.
  // An amendment is a re-signed change to an existing submission (same family),
  // not a brand-new submission — counting it would double-count the family.
  const realSubs = subs.filter((s) => !s.is_test && !s.is_addendum);
  const amendmentCount = subs.filter((s) => !s.is_test && s.is_addendum).length;
  const completionPct = realSubs.length + missing.length > 0
    ? Math.round((realSubs.length / (realSubs.length + missing.length)) * 100)
    : 0;

  const baseUrl = `/school/${locationId}/forms/${formId}/submissions?chrome=none`;
  const toggleTestUrl = baseUrl + (showTest ? '' : '&show_test=1');

  return (
    <main className="flex flex-1 flex-col bg-slate-50 p-6 min-h-screen">
      <div className="w-full max-w-6xl mx-auto space-y-4">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <div>
            <Link
              href={`/school/${locationId}/forms`}
              className="text-xs text-slate-500 hover:text-slate-700 inline-flex items-center gap-1"
            >
              <ArrowLeft className="h-3 w-3" /> Back to Forms
            </Link>
            <h1 className="text-2xl font-semibold text-slate-900 mt-1">{def.display_name}</h1>
            <p className="text-xs text-slate-500">
              <span className="font-mono">{def.slug}</span> · {def.per_student ? 'per-student form' : 'per-family form'}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Link
              href={toggleTestUrl}
              className={
                showTest
                  ? 'inline-flex items-center gap-1 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700'
                  : 'inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50'
              }
              title={showTest ? 'Hide test submissions' : 'Show test submissions'}
            >
              <FlaskConical className="h-3 w-3" />
              {showTest ? 'Hide tests' : `Show tests (${testCount})`}
            </Link>
            {showTest && testCount > 0 ? (
              <form
                action={`/api/admin/schools/${school.id}/forms/${formId}/test-submit/clear`}
                method="POST"
              >
                <input type="hidden" name="return_to" value={`/school/${locationId}/forms/${formId}/submissions?show_test=1&chrome=none`} />
                <button
                  type="submit"
                  className="inline-flex items-center gap-1 rounded-md border border-rose-300 bg-white px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50"
                  title="Hard-delete every test submission for this form. Real submissions are NOT touched."
                >
                  <Trash2 className="h-3 w-3" />
                  Clear all tests
                </button>
              </form>
            ) : null}
            <Link
              href={`/school/${locationId}/forms/${formId}`}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Edit form
            </Link>
          </div>
        </div>

        <HelpCallout
          title="How to read this page"
          steps={[
            <>The top section shows everyone who has <strong>submitted</strong>. Click any row to expand the answers.</>,
            <>The bottom section lists families (or family/student pairs, for per-student forms) that have <strong>not</strong> submitted yet. Those are who should still get the email blast.</>,
            <>The progress bar shows your completion rate. <strong>{completionPct}%</strong> of eligible families/students have submitted.</>,
            <>Phone + email on missing-recipient rows are copy-paste targets if you need to follow up manually.</>,
            <>The <strong>Engagement</strong> column tells you why a family is outstanding: <strong>Opened</strong> = they viewed the form but didn&rsquo;t submit (just nudge them), <strong>Logged in</strong> = active but hasn&rsquo;t reached this form, <strong>Never logged in</strong> = resend their portal invite.</>,
          ]}
        />

        {/* Progress bar */}
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-semibold text-slate-900">Completion</div>
            <div className="text-sm tabular-nums">
              <span className="font-semibold text-emerald-700">{realSubs.length}</span>
              <span className="text-slate-400"> / </span>
              <span className="text-slate-700">{realSubs.length + missing.length}</span>
              <span className="text-slate-500 ml-1">({completionPct}%)</span>
            </div>
          </div>
          <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
            <div className="h-full bg-emerald-500 transition-all" style={{ width: `${completionPct}%` }} />
          </div>
        </div>

        {/* Submitted */}
        <section className="rounded-lg border border-slate-200 bg-white overflow-hidden">
          <div className="border-b border-slate-100 px-4 py-2.5 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900 inline-flex items-center gap-2">
              <Inbox className="h-4 w-4 text-emerald-600" />
              Submitted ({realSubs.length})
              {amendmentCount > 0 ? (
                <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-800">
                  {amendmentCount} amended
                </span>
              ) : null}
            </h2>
          </div>
          {subs.length === 0 ? (
            <div className="p-10 text-center text-sm text-slate-500 italic">
              No submissions yet. Once parents start filling out the form, they&apos;ll appear here.
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {subs.map((s) => (
                <SubmissionRow
                  key={s.id}
                  s={s}
                  isOpen={openId === s.id}
                  locationId={locationId}
                  formId={formId}
                  fieldSchema={def.field_schema}
                />
              ))}
            </ul>
          )}
        </section>

        {/* Documents uploaded for this form */}
        {uploads.length > 0 ? (
          <section className="rounded-lg border border-slate-200 bg-white overflow-hidden">
            <div className="border-b border-slate-100 px-4 py-2.5">
              <h2 className="text-sm font-semibold text-slate-900 inline-flex items-center gap-2">
                <Paperclip className="h-4 w-4 text-slate-500" />
                Uploaded documents ({uploads.length})
              </h2>
            </div>
            <ul className="divide-y divide-slate-100">
              {uploads.map((u) => (
                <li key={u.id} className="px-4 py-2.5 flex items-center justify-between gap-3 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <FileText className="h-4 w-4 text-slate-400 shrink-0" />
                      <span className="text-sm font-medium text-slate-900 truncate">{u.display_name || u.original_filename}</span>
                      {u.acknowledged_at
                        ? <span className="rounded-full bg-emerald-100 px-1.5 py-0 text-[10px] font-medium text-emerald-800">received</span>
                        : <span className="rounded-full bg-amber-100 px-1.5 py-0 text-[10px] font-medium text-amber-800">new</span>}
                    </div>
                    <div className="mt-0.5 text-[11px] text-slate-500">
                      {u.family_label}{u.student_label ? ` · ${u.student_label}` : ''} · uploaded {new Date(u.uploaded_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                    </div>
                  </div>
                  <a
                    href={`/api/school/uploads/${u.id}/download`}
                    className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    <Download className="h-3.5 w-3.5" /> Download
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* Missing */}
        {missing.length > 0 ? (
          <section className="rounded-lg border border-amber-200 bg-amber-50/30 overflow-hidden">
            <div className="border-b border-amber-100 px-4 py-2.5 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-amber-900 inline-flex items-center gap-2">
                <Users className="h-4 w-4 text-amber-600" />
                Not yet submitted ({missing.length})
              </h2>
              <span className="text-[11px] text-amber-700">Send these families a reminder from Growth Suite</span>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-amber-100/60 text-left text-[10px] uppercase tracking-wide text-amber-900">
                <tr>
                  <th className="px-4 py-2 font-medium">Family</th>
                  {def.per_student ? <th className="px-4 py-2 font-medium">Student</th> : null}
                  <th className="px-4 py-2 font-medium">Primary parent email</th>
                  <th className="px-4 py-2 font-medium">Phone</th>
                  <th className="px-4 py-2 font-medium">Engagement</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-amber-100/60">
                {missing.map((m, i) => (
                  <tr key={`${m.family_id}-${m.student_id ?? 'fam'}-${i}`} className="hover:bg-amber-50/50">
                    <td className="px-4 py-2 text-slate-900">{m.family_label}</td>
                    {def.per_student ? (
                      <td className="px-4 py-2 text-slate-700">{m.student_label ?? '—'}</td>
                    ) : null}
                    <td className="px-4 py-2">
                      {m.parent_email ? (
                        <a href={`mailto:${m.parent_email}`} className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline">
                          <Mail className="h-3 w-3" />
                          {m.parent_email}
                        </a>
                      ) : <span className="text-xs text-slate-400 italic">none on file</span>}
                    </td>
                    <td className="px-4 py-2">
                      {m.parent_phone ? (
                        <a href={`tel:${m.parent_phone}`} className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline">
                          <Phone className="h-3 w-3" />
                          {m.parent_phone}
                        </a>
                      ) : <span className="text-xs text-slate-400 italic">—</span>}
                    </td>
                    <td className="px-4 py-2">
                      <EngagementCell familyId={m.family_id} viewedMap={viewedByFamily} loginMap={lastLoginByFamily} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : (
          <section className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900 text-center">
            🎉 Every eligible family has submitted this form.
          </section>
        )}
      </div>
    </main>
  );
}

function SubmissionRow({
  s, isOpen, locationId, formId, fieldSchema,
}: {
  s: Submission;
  isOpen: boolean;
  locationId: string;
  formId: string;
  fieldSchema: FormDef['field_schema'];
}) {
  const labelByKey: Record<string, string> = {};
  for (const f of fieldSchema ?? []) {
    if (f.key && f.label) labelByKey[f.key] = f.label;
  }
  // Hide internal `_`/`__` markers (amendment diff, review flags, signed-at
  // timestamps) from the raw response list — they're rendered specially below.
  const responseEntries = Object.entries(s.responses ?? {}).filter(([k, v]) =>
    !k.startsWith('_') &&
    v !== null && v !== undefined && v !== '' && (!Array.isArray(v) || v.length > 0),
  );

  // Amendment diff (Previous → New) stashed on the row by the submit route.
  const amendmentDiff = (s.is_addendum
    && s.responses
    && typeof (s.responses as Record<string, unknown>)._amendment_diff === 'object'
    && (s.responses as Record<string, unknown>)._amendment_diff)
    ? ((s.responses as Record<string, unknown>)._amendment_diff as Record<string, { old: unknown; new: unknown }>)
    : null;
  const diffEntries = amendmentDiff ? Object.entries(amendmentDiff) : [];

  const submittedDate = new Date(s.submitted_at);
  return (
    <li className="hover:bg-slate-50">
      <Link
        href={`/school/${locationId}/forms/${formId}/submissions?open=${isOpen ? '' : s.id}`}
        className="px-4 py-2.5 flex items-center gap-3 text-sm"
      >
        <ChevronDown className={`h-4 w-4 text-slate-400 transition-transform ${isOpen ? 'rotate-0' : '-rotate-90'}`} />
        <div className="min-w-0 flex-1">
          <div className="text-slate-900 font-medium flex items-center gap-2">
            {s.family_label}
            {s.is_test ? (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-800">
                <FlaskConical className="h-2.5 w-2.5" />
                test
              </span>
            ) : null}
            {s.is_addendum ? (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-800">
                <PencilLine className="h-2.5 w-2.5" />
                amendment{diffEntries.length > 0 ? ` · ${diffEntries.length} field${diffEntries.length === 1 ? '' : 's'}` : ''}
              </span>
            ) : null}
          </div>
          <div className="text-[11px] text-slate-500">
            {s.student_label ? `${s.student_label} · ` : ''}
            {s.is_test ? '(staff preview test — no real parent)' : (s.parent_email ?? '(no email)')}
          </div>
        </div>
        <div className="flex flex-col items-start gap-1">
          <StatusPill status={s.status} />
          {s.cosign_status === 'awaiting' ? (
            <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800" title="Waiting on the second guardian's signature">⏳ Awaiting 2nd signature</span>
          ) : s.cosign_status === 'signed' ? (
            <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-800" title="Both guardians have signed">✓ Both signed</span>
          ) : null}
        </div>
        <div className="text-[11px] text-slate-500 tabular-nums whitespace-nowrap min-w-[100px] text-right">
          {submittedDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
          <div className="text-[10px] text-slate-400">
            {submittedDate.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
          </div>
        </div>
      </Link>
      {isOpen ? (
        <div className="px-12 py-4 bg-slate-50 border-t border-slate-200 space-y-4">
          {/* Amendment banner: what the parent changed + re-signed, shown
              before the full response dump so staff act on it first. */}
          {s.is_addendum ? (
            <div className="rounded-md border border-blue-200 bg-blue-50 p-3">
              <div className="text-xs font-semibold text-blue-900 inline-flex items-center gap-1.5">
                <PencilLine className="h-3.5 w-3.5" />
                Parent amended {diffEntries.length > 0 ? `${diffEntries.length} field${diffEntries.length === 1 ? '' : 's'}` : 'this form'} and re-signed
              </div>
              <div className="mt-0.5 text-[11px] text-blue-700">
                {s.parent_submitted_at
                  ? `Amends the original submitted ${new Date(s.parent_submitted_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}. `
                  : ''}
                Re-signed {submittedDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}.
              </div>
              {diffEntries.length > 0 ? (
                <table className="mt-2 w-full text-xs border-collapse">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wide text-blue-800">
                      <th className="py-1 pr-3 font-medium">Field</th>
                      <th className="py-1 pr-3 font-medium">Previous</th>
                      <th className="py-1 font-medium">New</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diffEntries.map(([k, c]) => (
                      <tr key={k} className="border-t border-blue-100 align-top">
                        <td className="py-1 pr-3 font-medium text-slate-700">{labelByKey[k] ?? k}</td>
                        <td className="py-1 pr-3 text-slate-500 line-through break-words">{renderResponseValue(c.old)}</td>
                        <td className="py-1 text-emerald-700 font-medium break-words">{renderResponseValue(c.new)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="mt-1 text-[11px] text-blue-700 italic">Fields were re-affirmed (no value change detected).</div>
              )}
            </div>
          ) : null}

          {responseEntries.length === 0 ? (
            <div className="text-xs italic text-slate-500">No response data on this submission.</div>
          ) : (
            <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 text-sm">
              {responseEntries.map(([key, val]) => (
                <div key={key} className="flex flex-col">
                  <dt className="text-[11px] uppercase tracking-wide text-slate-500 font-medium">
                    {labelByKey[key] ?? key}
                  </dt>
                  <dd className="text-slate-900 break-words">
                    {renderResponseValue(val)}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      ) : null}
    </li>
  );
}

function renderResponseValue(val: unknown): React.ReactNode {
  if (val === null || val === undefined) return <span className="text-slate-400 italic">—</span>;
  if (typeof val === 'boolean') return val ? '✓ Yes' : '✗ No';
  if (typeof val === 'string') {
    if (val.startsWith('data:image/')) {
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={val} alt="signature" className="h-12 rounded border border-slate-300 bg-white" />;
    }
    return val;
  }
  if (typeof val === 'number') return val.toString();
  if (Array.isArray(val)) {
    return <span className="text-xs">{val.map((x) => String(x)).join(', ')}</span>;
  }
  return <code className="text-xs font-mono">{JSON.stringify(val)}</code>;
}

function StatusPill({ status }: { status: string }) {
  const cfg = status === 'paid'             ? { bg: 'bg-emerald-100', fg: 'text-emerald-800', label: 'Paid' }
            : status === 'submitted'        ? { bg: 'bg-emerald-100', fg: 'text-emerald-800', label: 'Submitted' }
            : status === 'pending_payment'  ? { bg: 'bg-amber-100',   fg: 'text-amber-800',   label: 'Pending payment' }
            : status === 'legacy_imported'  ? { bg: 'bg-slate-100',   fg: 'text-slate-600',   label: 'Imported' }
            :                                  { bg: 'bg-slate-100',   fg: 'text-slate-600',   label: status };
  return (
    <span className={`rounded-full ${cfg.bg} px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${cfg.fg}`}>
      {cfg.label}
    </span>
  );
}
