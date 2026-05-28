// Forms tab — the heart of the enrollment-form distribution story.
//
// Three sections (top → bottom):
//   1. "How this works" help callout. Numbered steps for the admin.
//   2. Quick stats: count of active forms, total submissions this year.
//   3. Per-form rows. Each one shows:
//      - Title + flags (active / needs-review / payment)
//      - Submission count + "View submissions" link
//      - "Send to families" button → expands into a panel with:
//          * The exact parent-portal URL families should land on
//          * A copy-pasteable email template (subject + body)
//          * A copy-pasteable SMS template (short version)
//          * A "Preview as parent" link (uses Michelle's seeded account)
//
// Bulk distribution model: we DON'T mint per-family magic links here.
// The operator drops the URL + template into their email workflow
// builder (Growth Suite's contacts / workflows surface) that fans out
// to the smart list of currently-enrolled families. The parent clicks
// the link, lands on the parent portal login, signs in, and is greeted
// by a "Pending enrollment forms" banner on /home.

import Link from 'next/link';
import { FileText, Edit3, Eye, Send, Inbox, ExternalLink, Plus } from 'lucide-react';
import { query } from '@/lib/db';
import { HelpCallout } from '@/components/HelpCallout';
import { CopyButton } from '@/components/CopyButton';
import { FormRowActions } from './FormRowActions';

const PARENT_PORTAL_BASE = process.env.PARENT_PORTAL_BASE_URL
  ?? 'https://growth-suite-parent-portal.vercel.app';

export async function PaymentsHubForms({
  schoolId, locationId,
}: { schoolId: string; locationId: string }) {
  const [{ rows: forms }, { rows: schoolRows }, { rows: familyCount }] = await Promise.all([
    query<{
      id: string;
      slug: string;
      display_name: string;
      description: string | null;
      category: string | null;
      field_count: number;
      is_active: boolean;
      per_student: boolean;
      has_payment: boolean;
      submission_count: number;
      submission_count_this_year: number;
    }>(
      `SELECT
         d.id, d.slug, d.display_name, d.description, d.category,
         jsonb_array_length(d.field_schema) AS field_count,
         d.is_active, d.per_student,
         (d.payment_config IS NOT NULL OR d.fee_amount IS NOT NULL) AS has_payment,
         (SELECT COUNT(*)::int FROM portal_form_submissions s
           WHERE s.form_definition_id = d.id) AS submission_count,
         (SELECT COUNT(*)::int FROM portal_form_submissions s
           WHERE s.form_definition_id = d.id
             AND s.submitted_at >= date_trunc('year', now())) AS submission_count_this_year
       FROM portal_form_definitions d
       WHERE d.school_id = $1
         AND COALESCE(d.audience, 'parents') = 'parents'   -- staff forms have their own UI under /staff-requests
       ORDER BY
         d.is_active DESC,                                 -- published first, drafts below

         CASE d.category
           WHEN 'registration' THEN 1
           WHEN 'medical' THEN 2
           WHEN 'permission' THEN 3
           WHEN 'release' THEN 4
           WHEN 'legal' THEN 5
           WHEN 'trip' THEN 6
           ELSE 9
         END,
         d.display_name`,
      [schoolId],
    ),
    query<{ name: string }>(
      `SELECT name FROM schools WHERE id = $1`, [schoolId],
    ),
    // Eligible recipients = active families with at least one currently-
    // enrolled student. This is the "smart list" the email workflow
    // should mirror. We show the count to give the operator a target number.
    query<{ n: number }>(
      `SELECT COUNT(DISTINCT f.id)::int AS n
         FROM families f
         JOIN students st ON st.family_id = f.id
        WHERE f.school_id = $1
          AND st.status = 'active'`,
      [schoolId],
    ),
  ]);

  const schoolName = schoolRows[0]?.name ?? 'this school';
  const eligibleFamilyCount = familyCount[0]?.n ?? 0;

  // Total active-year submissions across all forms (top KPI).
  const totalSubmissionsThisYear = forms.reduce((acc, f) => acc + f.submission_count_this_year, 0);
  // Count of forms tagged as registration/enrollment — those are the
  // ones the demo audience cares about.
  const enrollmentForms = forms.filter((f) => f.category === 'registration' || /enroll/i.test(f.display_name));
  const published = forms.filter((f) => f.is_active);
  const drafts    = forms.filter((f) => !f.is_active);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Forms & enrollment</h2>
          <p className="text-sm text-slate-500">
            Push forms to families through their parent portal. Send the email blast from Growth Suite using your enrolled-families list.
          </p>
        </div>
        {/* The "+ Create" button lands on the school-namespace new-form
            wizard so admins can build forms without escaping the iframe.
            Previously this was admin-only; the school-context API +
            route were added so the same flow works from inside GHL. */}
        <Link
          href={`/school/${locationId}/forms/new?chrome=none`}
          className="inline-flex items-center gap-1.5 rounded-md bg-emerald-700 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-800 shrink-0"
        >
          <Plus className="h-4 w-4" /> Create new form
        </Link>
      </div>

      {/* HOW THIS WORKS — numbered steps */}
      <HelpCallout
        title="How to push a form to families (5 steps)"
        steps={[
          <>
            Make sure the form below is <strong>Active</strong>. Click the <strong>Edit</strong> chip on a form row to
            change labels, add fields, or set pricing.
          </>,
          <>
            Click <strong>Send to families</strong> on the form&apos;s row. A panel will open with the parent-portal URL
            and a copy-pasteable email + SMS template.
          </>,
          <>
            In Growth Suite, open (or build) the smart list of <strong>currently-enrolled families</strong>. Create a
            workflow that emails (and/or texts) those parents using the template you copied.
          </>,
          <>
            Families click the link, log in to the parent portal, and are greeted with a <strong>Pending enrollment
            forms</strong> banner on their home page. They fill out the form for each student.
          </>,
          <>
            Submissions appear here in real time — click <strong>{eligibleFamilyCount} submissions</strong> (or whatever
            the count is) on the form row to see who has and hasn&apos;t completed it.
          </>,
        ]}
      />

      {/* Stat strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Published forms" value={String(published.length)} sublabel={drafts.length > 0 ? `+ ${drafts.length} draft${drafts.length === 1 ? '' : 's'}` : undefined} />
        <StatCard label="Enrollment forms" value={String(enrollmentForms.length)} />
        <StatCard label="Eligible families" value={String(eligibleFamilyCount)} sublabel="active students" />
        <StatCard label="Submissions YTD" value={String(totalSubmissionsThisYear)} />
      </div>

      {/* Published forms — visible to parents */}
      <section className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        <div className="border-b border-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-900 flex items-center justify-between">
          <span>Published — visible to parents ({published.length})</span>
          {published.length === 0 ? null : (
            <span className="text-xs font-normal text-slate-500">Click <strong>Send to families</strong> to get a copy-pasteable email template</span>
          )}
        </div>
        {published.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-500 italic">
            No published forms. Flip a draft below to Published, or talk to your Growth Suite contact to seed new forms.
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {published.map((f) => (
              <FormRow
                key={f.id}
                form={f}
                schoolId={schoolId}
                locationId={locationId}
                schoolName={schoolName}
                eligibleFamilyCount={eligibleFamilyCount}
              />
            ))}
          </ul>
        )}
      </section>

      {/* Drafts — hidden from parents */}
      {drafts.length > 0 ? (
        <section className="rounded-lg border border-amber-200 bg-amber-50/30 overflow-hidden">
          <div className="border-b border-amber-100 px-4 py-2.5 text-sm font-semibold text-amber-900 flex items-center justify-between">
            <span>Drafts — hidden from parents ({drafts.length})</span>
            <span className="text-xs font-normal text-amber-800">Flip Published on to make them visible.</span>
          </div>
          <ul className="divide-y divide-amber-100">
            {drafts.map((f) => (
              <FormRow
                key={f.id}
                form={f}
                schoolId={schoolId}
                locationId={locationId}
                schoolName={schoolName}
                eligibleFamilyCount={eligibleFamilyCount}
                draft
              />
            ))}
          </ul>
        </section>
      ) : null}
      {void locationId}
    </div>
  );
}

function FormRow({
  form, schoolId, locationId, schoolName, eligibleFamilyCount, draft,
}: {
  form: {
    id: string; slug: string; display_name: string; description: string | null;
    category: string | null; field_count: number; is_active: boolean;
    per_student: boolean; has_payment: boolean;
    submission_count: number; submission_count_this_year: number;
  };
  schoolId: string;
  locationId: string;
  schoolName: string;
  eligibleFamilyCount: number;
  draft?: boolean;
}) {
  // Staff preview lives inside the school iframe — no parent login screen,
  // no real submission. ?chrome=none keeps the dashboard sidebar from
  // doubling up with the preview's own header banner.
  const staffPreviewUrl = `/school/${locationId}/forms/${form.id}/preview?chrome=none`;
  const homeUrl = `${PARENT_PORTAL_BASE}/home`;

  // Email template that the operator drops into a Growth Suite email
  // workflow. {{contact.first_name}} is the merge token — when the
  // workflow runs, each recipient's name is filled in automatically.
  const emailSubject = `Action needed: ${form.display_name} for {{contact.first_name}}'s student`;
  const emailBody = `Hi {{contact.first_name}},

You have a pending form from ${schoolName}: ${form.display_name}.

Please log in to the parent portal to complete it. You'll find it on your home page under "Pending enrollment forms."

→ ${homeUrl}

If you have questions, reply to this email and our office team will get back to you within one business day.

Thanks,
${schoolName}`;

  const smsBody = `${schoolName}: please complete ${form.display_name} in your parent portal: ${homeUrl}`;

  return (
    <li className={`px-4 py-3 hover:bg-slate-50 ${draft ? 'opacity-90' : ''}`}>
      <div className="flex items-start gap-3">
        <FileText className={`h-4 w-4 shrink-0 mt-0.5 ${draft ? 'text-amber-500' : 'text-slate-400'}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-sm font-medium text-slate-900">{form.display_name}</span>
            {draft ? <Pill bg="bg-amber-100" fg="text-amber-900">Draft</Pill> : null}
            {form.has_payment ? <Pill bg="bg-emerald-100" fg="text-emerald-800">$ Payment</Pill> : null}
            {form.per_student ? <Pill bg="bg-blue-100" fg="text-blue-800">Per student</Pill> : null}
            {form.category ? <Pill bg="bg-slate-100" fg="text-slate-600">{form.category}</Pill> : null}
          </div>
          {form.description ? (
            <div className="text-xs text-slate-600 mt-0.5 max-w-xl">{form.description}</div>
          ) : null}
          <div className="text-[11px] text-slate-500 mt-1">
            <span className="font-mono">{form.slug}</span>
            {' · '}{form.field_count} field{form.field_count === 1 ? '' : 's'}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
          <Link
            href={`/school/${locationId}/forms/${form.id}/submissions`}
            className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
            title="View submissions for this form"
          >
            <Inbox className="h-3 w-3" /> {form.submission_count} submission{form.submission_count === 1 ? '' : 's'}
          </Link>
          <Link
            href={`/school/${locationId}/forms/${form.id}`}
            className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
          >
            <Edit3 className="h-3 w-3" /> Edit
          </Link>
          <FormRowActions
            schoolId={schoolId}
            formId={form.id}
            displayName={form.display_name}
            slug={form.slug}
            isPublished={form.is_active}
            submissionCount={form.submission_count}
          />
        </div>
      </div>

      {/* The interesting bit: send-to-families panel */}
      <details className="mt-3 ml-7 rounded-md border border-blue-200 bg-blue-50/40 group">
        <summary className="cursor-pointer list-none px-3 py-2 flex items-center gap-2 text-sm font-medium text-blue-800 hover:bg-blue-50">
          <Send className="h-4 w-4" />
          Send to {eligibleFamilyCount} enrolled families
          <span className="text-[11px] font-normal text-blue-700 ml-1">— get URL + email template for your Growth Suite workflow</span>
        </summary>
        <div className="px-4 py-3 space-y-4 border-t border-blue-100 bg-white">
          {/* Step A — URL */}
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-600 mb-1">
              1️⃣ &nbsp; Link to send parents
            </div>
            <p className="text-xs text-slate-600 mb-2">
              Send parents to their portal home — they&apos;ll see this form (and any others pending) in the
              <strong> &quot;Pending enrollment forms&quot;</strong> banner once they log in.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs font-mono text-slate-800 break-all">
                {homeUrl}
              </code>
              <CopyButton text={homeUrl} label="Copy link" />
            </div>
          </div>

          {/* Step B — Email template */}
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-600 mb-1">
              2️⃣ &nbsp; Email template (paste into your Growth Suite email workflow)
            </div>
            <p className="text-xs text-slate-600 mb-2">
              Uses the <code className="rounded bg-slate-100 px-1 font-mono text-[10px]">{`{{contact.first_name}}`}</code> merge token —
              each parent&apos;s name is filled in automatically when the workflow runs.
            </p>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="flex-1 rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs">
                  <span className="text-[10px] uppercase tracking-wide text-slate-500 mr-2">Subject:</span>
                  <span className="font-medium text-slate-800">{emailSubject}</span>
                </div>
                <CopyButton text={emailSubject} label="Copy subject" />
              </div>
              <div className="flex items-start gap-2">
                <pre className="flex-1 whitespace-pre-wrap rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs text-slate-800 font-sans leading-relaxed">{emailBody}</pre>
                <CopyButton text={emailBody} label="Copy body" />
              </div>
            </div>
          </div>

          {/* Step C — SMS template (optional) */}
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-600 mb-1">
              3️⃣ &nbsp; SMS template (optional — for follow-up nudges)
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs font-mono text-slate-800 break-all">
                {smsBody}
              </code>
              <CopyButton text={smsBody} label="Copy SMS" />
            </div>
          </div>

          {/* Step D — Preview */}
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-600 mb-1">
              4️⃣ &nbsp; Preview / test as a parent
            </div>
<p className="text-xs text-slate-600 mb-2">
              <strong>Preview the layout</strong> below — it opens inside this iframe (no login, no submission)
              so you can eyeball the form exactly as a parent sees it before pushing to families.
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              <Link
                href={staffPreviewUrl}
                className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-700"
              >
                <Eye className="h-3.5 w-3.5" /> Preview form layout
              </Link>
              <span className="text-[11px] text-slate-400">·</span>
              <a
                href={`${PARENT_PORTAL_BASE}/login?next=/forms-v2/${form.slug}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-700 underline"
                title={`Test parent login for ${schoolName}: michellelynnpt@gmail.com / dgm-demo-2026`}
              >
                <ExternalLink className="h-3 w-3" /> end-to-end test as a real parent (opens parent portal)
              </a>
            </div>
          </div>
        </div>
      </details>
    </li>
  );
}

function StatCard({ label, value, sublabel }: { label: string; value: string; sublabel?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3.5">
      <div className="text-[11px] uppercase tracking-wide text-slate-500 font-medium">{label}</div>
      <div className="text-2xl font-semibold text-slate-900 tabular-nums mt-0.5">{value}</div>
      {sublabel ? <div className="text-[11px] text-slate-500 tabular-nums mt-0.5">{sublabel}</div> : null}
    </div>
  );
}

function Pill({ children, bg, fg }: { children: React.ReactNode; bg: string; fg: string }) {
  return <span className={`inline-block rounded-full ${bg} px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${fg}`}>{children}</span>;
}
