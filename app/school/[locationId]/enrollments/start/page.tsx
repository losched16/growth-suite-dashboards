// /school/[locationId]/enrollments/start — school-scoped enrollment
// starter. Mirrors the admin page but its back / cancel links return
// to the Payments hub Plans tab so the operator never escapes the
// GHL-embedded DGM iframe.
//
// The form POSTs to /api/admin/schools/{schoolId}/enrollments/start
// (same as the /admin route). We pass a hidden `return_to` field so
// the API redirects back to THIS page after success/failure, instead
// of bouncing the operator to /admin.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, FileText } from 'lucide-react';
import { query } from '@/lib/db';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { HelpCallout } from '@/components/HelpCallout';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type Params = Promise<{ locationId: string }>;
type SearchParams = Promise<{ msg?: string; err?: string; invite_id?: string }>;

interface FormOption { id: string; slug: string; display_name: string }
interface FamilyOption { id: string; label: string }
interface StudentOption { id: string; family_id: string; name: string }
interface RecentInvite {
  id: string;
  created_at: string;
  family_label: string;
  student_name: string | null;
  form_slug: string;
  token: string;
  sent_at: string | null;
  consumed_at: string | null;
}

const PARENT_PORTAL_BASE = process.env.PARENT_PORTAL_BASE_URL
  ?? 'https://growth-suite-parent-portal.vercel.app';

export default async function StartEnrollmentScoped({
  params, searchParams,
}: { params: Params; searchParams: SearchParams }) {
  const { locationId } = await params;
  const sp = await searchParams;

  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();
  const schoolId = school.id;

  const [{ rows: forms }, { rows: families }, { rows: students }, { rows: recent }] = await Promise.all([
    query<FormOption>(
      `SELECT id, slug, display_name
         FROM portal_form_definitions
        WHERE school_id = $1 AND is_active = true
        ORDER BY (category = 'enrollment') DESC, display_name`,
      [schoolId],
    ),
    query<FamilyOption>(
      `SELECT f.id,
              COALESCE(NULLIF(f.display_name, ''),
                       CONCAT_WS(' ', p.first_name, p.last_name),
                       '(unnamed)') AS label
         FROM families f
         LEFT JOIN LATERAL (
           SELECT first_name, last_name FROM parents
           WHERE family_id = f.id AND is_primary = true LIMIT 1
         ) p ON true
        WHERE f.school_id = $1 AND f.status = 'active'
        ORDER BY label
        LIMIT 1000`,
      [schoolId],
    ),
    query<StudentOption>(
      `SELECT id, family_id,
              CONCAT_WS(' ', COALESCE(NULLIF(preferred_name, ''), first_name), last_name) AS name
         FROM students
        WHERE school_id = $1 AND status = 'active'
        ORDER BY first_name, last_name
        LIMIT 5000`,
      [schoolId],
    ),
    query<RecentInvite>(
      `SELECT i.id, i.created_at, i.token, i.sent_at, i.consumed_at,
              COALESCE(NULLIF(f.display_name, ''),
                       CONCAT_WS(' ', p.first_name, p.last_name),
                       '(unnamed)') AS family_label,
              CASE WHEN st.id IS NOT NULL
                   THEN CONCAT_WS(' ', COALESCE(NULLIF(st.preferred_name, ''), st.first_name), st.last_name)
                   ELSE NULL END AS student_name,
              d.slug AS form_slug
         FROM enrollment_invites i
         JOIN portal_form_definitions d ON d.id = i.form_definition_id
         JOIN families f ON f.id = i.family_id
         LEFT JOIN students st ON st.id = i.student_id
         LEFT JOIN LATERAL (
           SELECT first_name, last_name FROM parents
           WHERE family_id = f.id AND is_primary = true LIMIT 1
         ) p ON true
        WHERE i.school_id = $1
        ORDER BY i.created_at DESC
        LIMIT 25`,
      [schoolId],
    ),
  ]);

  // If we just created one, surface its link prominently.
  let justCreated: RecentInvite | null = null;
  if (sp.invite_id) {
    justCreated = recent.find((r) => r.id === sp.invite_id) ?? null;
  }

  // Where the API should redirect after handling the POST. Keeps the
  // operator inside the school iframe.
  const returnTo = `/school/${locationId}/enrollments/start`;

  return (
    <main className="flex flex-1 flex-col items-center bg-slate-50 p-6 min-h-screen">
      <div className="w-full max-w-3xl space-y-4">
        <Link
          href={`/school/${locationId}/payments?tab=plans`}
          className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"
        >
          <ArrowLeft className="h-3 w-3" /> Back to Tuition Plans
        </Link>

        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Start an enrollment</h1>
          <p className="text-xs text-slate-500 mt-1">
            Pre-fill the student start date + grade level. The parent gets an email with a one-click link
            to complete the rest of the enrollment agreement.
          </p>
        </div>

        <HelpCallout
          title="What happens when you click 'Create invite'"
          defaultOpen={false}
          steps={[
            <>An <strong>enrollment_invite</strong> row is created with a unique magic-link token tied to this family + student.</>,
            <>If <strong>Email the parent</strong> is checked, the primary parent gets an email with a personalized link to fill out the form.</>,
            <>The parent clicks the link, lands directly on the form (already authenticated as them, no login needed), and submits.</>,
            <>The submission appears in <strong>Forms → submissions inbox</strong> with status <strong>Submitted</strong>.</>,
          ]}
        />

        {sp.msg ? (
          <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{sp.msg}</div>
        ) : null}
        {sp.err ? (
          <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{sp.err}</div>
        ) : null}

        {justCreated ? (
          <div className="rounded-lg border-2 border-emerald-300 bg-emerald-50 p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-emerald-900 mb-1">
              ✓ Invite created — share this link
            </div>
            <div className="text-sm text-emerald-900 mb-2">
              For <strong>{justCreated.family_label}</strong>
              {justCreated.student_name ? ` · ${justCreated.student_name}` : ''}
              {justCreated.sent_at ? ' (email sent)' : ' (email not sent — copy and share manually)'}
            </div>
            <div className="rounded border border-emerald-200 bg-white px-3 py-1.5 text-xs font-mono break-all">
              {PARENT_PORTAL_BASE}/forms-v2/{justCreated.form_slug}?invite={justCreated.token}
            </div>
          </div>
        ) : null}

        <form
          action={`/api/admin/schools/${schoolId}/enrollments/start`}
          method="POST"
          className="rounded-xl border border-slate-200 bg-white p-5 space-y-4"
        >
          {/* Tells the API to redirect back HERE (school namespace) instead
              of /admin/.../enrollments/start. */}
          <input type="hidden" name="return_to" value={returnTo} />

          <FieldGroup>
            <Label>Form</Label>
            <select name="form_definition_id" required className={inputCls}>
              <option value="">— select a form —</option>
              {forms.map((f) => (
                <option key={f.id} value={f.id}>{f.display_name}</option>
              ))}
            </select>
          </FieldGroup>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FieldGroup>
              <Label>Family</Label>
              <select name="family_id" required className={inputCls}>
                <option value="">— select a family —</option>
                {families.map((f) => (
                  <option key={f.id} value={f.id}>{f.label}</option>
                ))}
              </select>
            </FieldGroup>
            <FieldGroup>
              <Label>Student (optional)</Label>
              <select name="student_id" className={inputCls}>
                <option value="">— pick a family first —</option>
                {students.map((s) => (
                  <option key={s.id} value={s.id} data-family={s.family_id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <Hint>For per-student forms, this scopes the invite to one child.</Hint>
            </FieldGroup>
          </div>

          <div className="border-t border-slate-100 pt-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600 mb-2">
              Pre-filled values (parent sees these as starting points)
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <FieldGroup>
                <Label>Enrollment start date</Label>
                <input type="date" name="prefill_enrollment_start_date" className={inputCls} />
              </FieldGroup>
              <FieldGroup>
                <Label>Grade level</Label>
                <select name="prefill_grade_level" className={inputCls}>
                  <option value="">— leave blank —</option>
                  <option value="infant">Infant (6 wk – 12 mo)</option>
                  <option value="toddler">Toddler (12 mo – 3 yr)</option>
                  <option value="primary">Primary (3 – 6 yr)</option>
                  <option value="lower_elementary">Lower Elementary (6 – 9 yr)</option>
                  <option value="upper_elementary">Upper Elementary (9 – 12 yr)</option>
                  <option value="middle_years">Middle Years (12 – 16 yr)</option>
                  <option value="high_school">High School (16 – 18 yr)</option>
                </select>
              </FieldGroup>
            </div>
          </div>

          <FieldGroup>
            <Label>Internal note (operator-only, not shown to parent)</Label>
            <input type="text" name="internal_note" className={inputCls} placeholder="e.g. starts late, prorated tuition" />
          </FieldGroup>

          <div className="rounded-md bg-slate-50 border border-slate-200 p-3">
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="send_email" value="1" defaultChecked className="mt-0.5 h-4 w-4 rounded border-slate-300" />
              <span>
                <strong>Email the parent the invite link now.</strong>
                <span className="block text-xs text-slate-500">
                  Uncheck if you want to send the link yourself (you&rsquo;ll see the URL on the next screen).
                </span>
              </span>
            </label>
          </div>

          <div className="flex items-center gap-2 pt-2 border-t border-slate-100">
            <button type="submit"
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
              <FileText className="inline h-4 w-4 mr-1" /> Create invite
            </button>
            <Link href={`/school/${locationId}/payments?tab=plans`}
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">
              Cancel
            </Link>
          </div>
        </form>

        {/* Recent invites */}
        <section className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="border-b border-slate-100 px-4 py-2 text-sm font-semibold text-slate-700">
            Recent invites ({recent.length})
          </div>
          {recent.length === 0 ? (
            <div className="p-6 text-center text-sm text-slate-500 italic">No invites yet.</div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {recent.map((r) => (
                <li key={r.id} className="px-4 py-2.5 flex items-baseline justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm text-slate-900">
                      {r.family_label}
                      {r.student_name ? <span className="text-slate-500"> · {r.student_name}</span> : null}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      <span className="font-mono">{r.form_slug}</span>
                      {' · '}{new Date(r.created_at).toLocaleString()}
                      {r.sent_at ? ' · emailed' : ''}
                    </div>
                  </div>
                  <div>
                    {r.consumed_at ? (
                      <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800">
                        consumed
                      </span>
                    ) : (
                      <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                        pending
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}

const inputCls =
  'mt-0.5 block w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none';
function FieldGroup({ children }: { children: React.ReactNode }) { return <label className="block">{children}</label>; }
function Label({ children }: { children: React.ReactNode }) { return <span className="text-[11px] font-medium uppercase tracking-wide text-slate-600">{children}</span>; }
function Hint({ children }: { children: React.ReactNode }) { return <span className="block text-[10px] text-slate-500 mt-0.5">{children}</span>; }
