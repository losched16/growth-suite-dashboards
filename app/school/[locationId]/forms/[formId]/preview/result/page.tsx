// /school/[locationId]/forms/[formId]/preview/result?submission=<id>
//
// Landing page after a TEST submission. Two halves:
//
//   TOP — what the parent would see:
//     - The school's configured thank-you message (if set)
//     - A note that a real parent would auto-redirect here:
//       confirmation_redirect_url (if set)
//     - The default "Thanks, we got it" if neither is configured
//
//   BOTTOM — staff-only "Behind the scenes" panel:
//     - The submitted responses (key → value, for verification)
//     - Notifications that WOULD have fired (notify_emails recipients)
//     - GHL contact-field writes that WOULD have happened
//     - Payment that WOULD have been charged (with $0 vs real amount)
//     - Skipped files (test mode doesn't upload)
//
// Quick actions in the BOTTOM panel:
//   - "Run another test" → back to /preview?test=1
//   - "View raw row in inbox" → /school/.../submissions?show_test=1
//   - (Phase 3) "Send me the notification email" — separate commit

import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, CheckCircle2, ExternalLink, FlaskConical, Inbox, Mail, Send, Sparkles, Wallet } from 'lucide-react';
import { query } from '@/lib/db';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';

export const dynamic = 'force-dynamic';

type Params = Promise<{ locationId: string; formId: string }>;
type SearchParams = Promise<{ submission?: string }>;

interface DefRow {
  id: string;
  slug: string;
  display_name: string;
  confirmation_message: string | null;
  confirmation_redirect_url: string | null;
  notify_emails: string[] | null;
  field_schema: Array<Record<string, unknown>>;
  payment_config: Record<string, unknown> | null;
  fee_amount: string | null;
  ghl_writeback: Array<{ field_key: string; ghl_field_key: string; per_student?: boolean }> | null;
}

interface SubmissionRow {
  id: string;
  responses: Record<string, unknown>;
  submitted_at: Date | string;
  is_test: boolean;
}

export default async function TestResultPage({
  params, searchParams,
}: { params: Params; searchParams: SearchParams }) {
  const { locationId, formId } = await params;
  const sp = await searchParams;
  if (!sp.submission) {
    redirect(`/school/${locationId}/forms/${formId}/preview?chrome=none&test=1`);
  }

  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();

  const [{ rows: defRows }, { rows: subRows }] = await Promise.all([
    query<DefRow>(
      `SELECT id, slug, display_name, confirmation_message, confirmation_redirect_url,
              notify_emails, field_schema, payment_config, fee_amount, ghl_writeback
         FROM portal_form_definitions
        WHERE id = $1 AND school_id = $2`,
      [formId, school.id],
    ),
    query<SubmissionRow>(
      `SELECT id, responses, submitted_at, is_test
         FROM portal_form_submissions
        WHERE id = $1 AND school_id = $2 AND form_definition_id = $3`,
      [sp.submission, school.id, formId],
    ),
  ]);

  if (defRows.length === 0 || subRows.length === 0) notFound();
  const form = defRows[0];
  const sub = subRows[0];

  if (!sub.is_test) {
    // Real submissions don't land here — guard so we never leak a real
    // parent submission into the test result page.
    redirect(`/school/${locationId}/forms/${formId}/submissions`);
  }

  // Strip our internal __test_meta__ from the response listing.
  const meta = (sub.responses['__test_meta__'] ?? {}) as { skipped_files?: string[]; actor?: string };
  const cleanResponses: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(sub.responses)) {
    if (k !== '__test_meta__') cleanResponses[k] = v;
  }

  const previewBackUrl = `/school/${locationId}/forms/${formId}/preview?chrome=none`;
  const testAgainUrl = `${previewBackUrl}&test=1`;
  const inboxUrl = `/school/${locationId}/forms/${formId}/submissions?show_test=1&chrome=none`;

  return (
    <main className="min-h-screen bg-zinc-100">
      {/* Sticky test-mode banner */}
      <div className="sticky top-0 z-10 border-b border-emerald-400 bg-emerald-50 px-4 py-2 text-xs">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 flex-wrap text-emerald-900">
          <div className="flex items-center gap-2">
            <FlaskConical className="h-4 w-4" />
            <strong>TEST SUBMISSION RECEIVED</strong>
            <span className="text-emerald-800">
              · {school.name} · {form.display_name}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Link href={testAgainUrl} className="inline-flex items-center gap-1 rounded border border-emerald-500 bg-white px-2 py-1 hover:bg-emerald-100">
              <FlaskConical className="h-3 w-3" /> Run another test
            </Link>
            <Link href={inboxUrl} className="inline-flex items-center gap-1 rounded border border-emerald-500 bg-white px-2 py-1 hover:bg-emerald-100">
              <Inbox className="h-3 w-3" /> View in inbox
            </Link>
            <Link href={previewBackUrl} className="inline-flex items-center gap-1 hover:underline">
              <ArrowLeft className="h-3 w-3" /> Back to preview
            </Link>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-3xl px-4 py-6 sm:py-8 space-y-6">

        {/* ── TOP HALF: what the parent would see ────────────────── */}
        <section className="rounded-xl border-2 border-blue-300 bg-white">
          <div className="border-b border-blue-200 bg-blue-50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-blue-900 flex items-center gap-2">
            <Sparkles className="h-4 w-4" /> What your parent will see
          </div>
          <div className="px-6 py-6 sm:py-8">
            <div className="flex items-start gap-3 mb-4">
              <CheckCircle2 className="h-6 w-6 text-emerald-600 mt-0.5 shrink-0" />
              <div>
                <h1 className="text-xl font-semibold text-zinc-900">Thanks — we got your form!</h1>
                <p className="text-xs text-zinc-500 mt-1">Submitted just now</p>
              </div>
            </div>

            {form.confirmation_message ? (
              <div className="mt-3 rounded-md bg-zinc-50 border border-zinc-200 px-4 py-3 text-sm text-zinc-800 whitespace-pre-wrap">
                {form.confirmation_message}
              </div>
            ) : (
              <p className="text-sm text-zinc-600 italic">
                No custom thank-you message configured.
                <Link href={`/school/${locationId}/forms/${formId}?chrome=none`} className="text-blue-600 ml-1 underline hover:text-blue-800">
                  Add one in the form editor →
                </Link>
              </p>
            )}

            {form.confirmation_redirect_url ? (
              <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                <strong>Auto-redirect:</strong> a real parent would be sent to{' '}
                <a href={form.confirmation_redirect_url} target="_blank" rel="noreferrer" className="font-mono break-all underline hover:text-amber-700">
                  {form.confirmation_redirect_url}
                </a>{' '}
                after seeing this page. (Suppressed here so you can review the test.)
              </div>
            ) : null}
          </div>
        </section>

        {/* ── BOTTOM HALF: behind the scenes ─────────────────────── */}
        <section className="rounded-xl border border-zinc-300 bg-white">
          <div className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-zinc-700 flex items-center gap-2">
            <FlaskConical className="h-4 w-4" /> Behind the scenes (test mode — none of this actually fired)
          </div>

          <div className="divide-y divide-zinc-100">
            {/* SUBMITTED RESPONSES */}
            <Block
              icon={<Inbox className="h-4 w-4 text-zinc-500" />}
              title="Submitted responses"
              hint="Exactly what the API recorded for this test submission."
            >
              {Object.keys(cleanResponses).length === 0 ? (
                <p className="text-xs text-zinc-500 italic">No fields filled in.</p>
              ) : (
                <dl className="grid grid-cols-1 sm:grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
                  {Object.entries(cleanResponses).map(([k, v]) => (
                    <ResponsePair key={k} k={k} v={v} />
                  ))}
                </dl>
              )}
            </Block>

            {/* NOTIFICATIONS */}
            <Block
              icon={<Mail className="h-4 w-4 text-zinc-500" />}
              title="Office notifications"
              hint="People who would have been emailed about this submission in production."
            >
              {form.notify_emails && form.notify_emails.length > 0 ? (
                <>
                  <p className="text-xs text-emerald-700 mb-2">
                    <strong>Suppressed</strong> in test mode. In production, the following addresses would receive a summary email:
                  </p>
                  <ul className="space-y-1 text-sm">
                    {form.notify_emails.map((e) => (
                      <li key={e} className="font-mono text-zinc-800">
                        <Send className="inline h-3 w-3 mr-1 text-emerald-600" />
                        {e}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="text-xs text-zinc-500 italic">
                  No office notification emails configured.
                  <Link href={`/school/${locationId}/forms/${formId}?chrome=none`} className="text-blue-600 ml-1 underline hover:text-blue-800">
                    Add some in the form editor →
                  </Link>
                </p>
              )}
            </Block>

            {/* GHL WRITEBACK */}
            <Block
              icon={<ArrowRight className="h-4 w-4 text-zinc-500" />}
              title="GHL contact field writes"
              hint="Custom-field writebacks that would have hit the parent's GHL contact record."
            >
              {form.ghl_writeback && form.ghl_writeback.length > 0 ? (
                <>
                  <p className="text-xs text-emerald-700 mb-2">
                    <strong>Suppressed</strong> in test mode. In production these writes would have run:
                  </p>
                  <ul className="space-y-1.5 text-xs">
                    {form.ghl_writeback.map((wb, i) => {
                      const responseValue = cleanResponses[wb.field_key];
                      return (
                        <li key={i} className="flex items-start gap-2 font-mono">
                          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-700">{wb.field_key}</span>
                          <ArrowRight className="h-3 w-3 mt-0.5 text-zinc-400 shrink-0" />
                          <span className="rounded bg-blue-50 px-1.5 py-0.5 text-blue-800">{wb.ghl_field_key}{wb.per_student ? ' (per-student slot)' : ''}</span>
                          <span className="ml-auto text-zinc-600">
                            {responseValue == null
                              ? <span className="italic text-zinc-400">(no value submitted)</span>
                              : `= ${truncate(String(responseValue))}`}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </>
              ) : (
                <p className="text-xs text-zinc-500 italic">
                  This form has no GHL writeback rules configured. (Writebacks are added separately via the operator GHL field mapping tool.)
                </p>
              )}
            </Block>

            {/* PAYMENT */}
            <Block
              icon={<Wallet className="h-4 w-4 text-zinc-500" />}
              title="Payment (Stripe Connect)"
              hint="What would have been charged on the school's Stripe Connect account."
            >
              {form.payment_config || form.fee_amount ? (
                <>
                  <p className="text-xs text-emerald-700 mb-2">
                    <strong>Suppressed</strong> in test mode &mdash; no Stripe Checkout session was created.
                  </p>
                  <p className="text-sm text-zinc-800">
                    In production this submission would have routed to Stripe Checkout with:
                  </p>
                  <ul className="mt-2 space-y-1 text-sm font-mono text-zinc-700">
                    {form.fee_amount ? (
                      <li>Flat fee: <span className="text-zinc-900 font-semibold">${form.fee_amount}</span></li>
                    ) : null}
                    {form.payment_config ? (
                      <li>Computed total: per <code className="bg-zinc-100 px-1 rounded">payment_config</code> (see editor for full spec)</li>
                    ) : null}
                  </ul>
                </>
              ) : (
                <p className="text-xs text-zinc-500 italic">No payment configured on this form.</p>
              )}
            </Block>

            {/* SKIPPED FILES */}
            {meta.skipped_files && meta.skipped_files.length > 0 ? (
              <Block
                icon={<ExternalLink className="h-4 w-4 text-zinc-500" />}
                title="Files skipped"
                hint="Test mode doesn't store file uploads."
              >
                <ul className="space-y-1 text-xs font-mono text-zinc-700">
                  {meta.skipped_files.map((k) => <li key={k}>{k}</li>)}
                </ul>
              </Block>
            ) : null}
          </div>

          <div className="border-t border-zinc-200 bg-zinc-50 px-4 py-3 flex items-center justify-between flex-wrap gap-2">
            <span className="text-[11px] text-zinc-500">
              Test submission ID: <code className="font-mono">{sub.id.slice(0, 8)}…</code>
            </span>
            <div className="flex items-center gap-2">
              <Link href={testAgainUrl} className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700">
                <FlaskConical className="h-3 w-3" /> Run another test
              </Link>
              <Link href={inboxUrl} className="inline-flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50">
                <Inbox className="h-3 w-3" /> View raw submission in inbox
              </Link>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

function Block({
  icon, title, hint, children,
}: { icon: React.ReactNode; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <h3 className="text-sm font-semibold text-zinc-800">{title}</h3>
      </div>
      {hint ? <p className="text-[11px] text-zinc-500 mb-2">{hint}</p> : null}
      {children}
    </div>
  );
}

function ResponsePair({ k, v }: { k: string; v: unknown }) {
  let display: string;
  if (v == null) display = '(empty)';
  else if (Array.isArray(v)) display = v.length === 0 ? '(none)' : v.map(String).join(', ');
  else if (typeof v === 'boolean') display = v ? 'yes' : 'no';
  else if (typeof v === 'string' && v.startsWith('data:')) display = '(data URL — signature/file)';
  else display = String(v);
  return (
    <>
      <dt className="font-mono text-xs text-zinc-600 break-all">{k}</dt>
      <dd className="text-zinc-800 break-words">{truncate(display, 200)}</dd>
    </>
  );
}

function truncate(s: string, max = 80): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
