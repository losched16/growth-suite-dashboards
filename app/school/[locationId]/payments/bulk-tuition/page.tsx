// /school/[locationId]/payments/bulk-tuition — bulk-schedule tuition for
// every already-enrolled student from their imported FACTS data, all
// anchored to one first payment date. Shows a full preview (who's ready,
// who's skipped + why, the totals) BEFORE anything is created. Commit
// reuses the standard generator, so autopay + schedule match the normal
// flow. While the school is in dry-run, the created invoices are drafts.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, CalendarClock, CheckCircle2, AlertTriangle } from 'lucide-react';
import { query } from '@/lib/db';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { planFactsBulk, type AmountBasis } from '@/lib/billing/facts-bulk';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Params = Promise<{ locationId: string }>;
type SearchParams = Promise<{ amount_basis?: string; first_due_date?: string; msg?: string; err?: string }>;

const YEAR = '2026-27';
const fmt = (c: number) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

export default async function BulkTuitionPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { locationId } = await params;
  const sp = await searchParams;
  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();
  const schoolId = school.id;

  // Default to 'remaining' so a mid-year migration bills only what the
  // family still owes after FACTS payments — billing 'net' here re-bills
  // amounts already collected in FACTS (e.g. enrollment fees / deposits).
  const amountBasis: AmountBasis = sp.amount_basis === 'net' ? 'net' : 'remaining';
  const firstDue = /^\d{4}-\d{2}-\d{2}$/.test(sp.first_due_date ?? '') ? sp.first_due_date! : '2026-07-01';

  const [plan, { rows: cfgRows }] = await Promise.all([
    planFactsBulk(schoolId, { amountBasis, academicYear: YEAR }),
    query<{ billing_active: boolean }>(
      `SELECT COALESCE(billing_active, false) AS billing_active FROM school_payment_config WHERE school_id = $1`,
      [schoolId],
    ),
  ]);
  const billingActive = !!cfgRows[0]?.billing_active;
  const backHref = `/school/${locationId}/payments?tab=plans`;
  const returnTo = backHref;

  return (
    <main className="flex flex-1 flex-col items-center bg-slate-50 p-6 min-h-screen">
      <div className="w-full max-w-4xl space-y-4">
        <Link href={backHref} className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700">
          <ArrowLeft className="h-3 w-3" /> Back to Tuition Plans
        </Link>

        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Schedule tuition from FACTS</h1>
          <p className="text-xs text-slate-500 mt-1">
            Set up the payment schedule for every already-enrolled student at once, using their imported
            FACTS amounts and the plan each family chose. Everything is anchored to one first payment date.
          </p>
        </div>

        {sp.msg ? <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{sp.msg}</div> : null}
        {sp.err ? <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{sp.err}</div> : null}

        {/* Controls — change these to refresh the preview */}
        <form method="GET" className="rounded-xl border border-slate-200 bg-white p-4 grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wide text-slate-600">First payment date</span>
            <input type="date" name="first_due_date" defaultValue={firstDue} className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1.5 text-sm" />
          </label>
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wide text-slate-600">Amount to schedule</span>
            <select name="amount_basis" defaultValue={amountBasis} className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1.5 text-sm">
              <option value="remaining">Remaining balance — what families still owe after FACTS payments (recommended)</option>
              <option value="net">Net charges — full year, ignores FACTS payments already made</option>
            </select>
          </label>
          <button type="submit" className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
            Update preview
          </button>
        </form>

        {/* Summary */}
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Ready to schedule" value={String(plan.ready_count)} tone="ok" />
          <Stat label="Total annual" value={fmt(plan.total_amount_cents)} />
          <Stat label="Skipped" value={String(plan.skipped_count)} tone={plan.skipped_count ? 'warn' : undefined} />
        </div>

        {!billingActive ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <strong>Test mode is on.</strong> These schedules are created as drafts — no one is charged and parents
            won&rsquo;t see them — until you click <strong>Go live</strong> in Payments settings. Safe to run and review.
          </div>
        ) : null}

        {/* Commit */}
        <form action={`/api/admin/schools/${schoolId}/payments/bulk-facts-tuition`} method="POST" className="rounded-xl border border-blue-200 bg-blue-50/40 p-4">
          <input type="hidden" name="first_due_date" value={firstDue} />
          <input type="hidden" name="amount_basis" value={amountBasis} />
          <input type="hidden" name="return_to" value={returnTo} />
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-sm text-slate-700">
              Create schedules for the <strong>{plan.ready_count}</strong> ready student{plan.ready_count === 1 ? '' : 's'} —
              first payment <strong>{firstDue}</strong>, autopay on. Already-scheduled students are skipped.
            </p>
            <button type="submit" disabled={plan.ready_count === 0}
              className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
              <CalendarClock className="h-4 w-4" /> Create {plan.ready_count} schedules
            </button>
          </div>
        </form>

        {/* Preview table */}
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-100 text-left text-[10px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">Student</th>
                <th className="px-3 py-2 font-medium">Program</th>
                <th className="px-3 py-2 font-medium">Plan</th>
                <th className="px-3 py-2 font-medium text-right">Annual</th>
                <th className="px-3 py-2 font-medium text-center">Payments</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {plan.rows.map((r) => (
                <tr key={r.student_id} className={r.ready ? '' : 'bg-slate-50/60'}>
                  <td className="px-3 py-2">
                    <div className="text-slate-900">{r.student_name}</div>
                    <div className="text-[11px] text-slate-500">{r.family_label}</div>
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-600">{r.program ?? '—'}</td>
                  <td className="px-3 py-2 text-xs text-slate-700">{r.resolved_plan_label ?? r.plan_label ?? '—'}</td>
                  <td className="px-3 py-2 text-right font-mono align-top">
                    {r.amount_cents > 0 ? (
                      r.breakdown.length ? (
                        <details className="text-right">
                          <summary className="cursor-pointer list-none whitespace-nowrap">
                            {fmt(r.amount_cents)} <span className="text-[10px] font-sans text-blue-600">▸ breakdown</span>
                          </summary>
                          <div className="mt-1 space-y-0.5 text-[11px] font-normal font-sans text-slate-600">
                            {r.breakdown.map((b) => (
                              <div key={b.key} className="flex justify-between gap-3">
                                <span>{b.label}</span>
                                <span className={b.kind !== 'charge' ? 'text-emerald-700' : ''}>
                                  {b.kind !== 'charge' ? '−' : ''}{fmt(Math.abs(b.amount_cents))}
                                </span>
                              </div>
                            ))}
                            {(() => {
                              const bdNet = r.breakdown.reduce((a, b) => a + b.amount_cents, 0);
                              return bdNet !== r.amount_cents ? (
                                <div className="flex justify-between gap-3"><span>Payments already made</span><span className="text-emerald-700">−{fmt(bdNet - r.amount_cents)}</span></div>
                              ) : null;
                            })()}
                            <div className="flex justify-between gap-3 border-t border-slate-200 pt-0.5 font-semibold text-slate-800">
                              <span>To schedule</span><span>{fmt(r.amount_cents)}</span>
                            </div>
                          </div>
                        </details>
                      ) : fmt(r.amount_cents)
                    ) : '—'}
                  </td>
                  <td className="px-3 py-2 text-center tabular-nums">{r.installment_count || '—'}</td>
                  <td className="px-3 py-2">
                    {r.ready ? (
                      <span className="inline-flex items-center gap-1 text-emerald-700 text-xs"><CheckCircle2 className="h-3.5 w-3.5" /> Ready</span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-amber-700 text-xs" title={r.reason}><AlertTriangle className="h-3.5 w-3.5" /> {r.reason}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-slate-500">
          Skipped students stay untouched — fix the underlying data (add their FACTS ledger, payment plan, or a
          matching tuition grid) and re-run; already-scheduled students are never double-charged.
        </p>
      </div>
    </main>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' }) {
  const cls = tone === 'ok' ? 'border-emerald-200 bg-emerald-50/40' : tone === 'warn' ? 'border-amber-200 bg-amber-50/40' : 'border-slate-200 bg-white';
  return (
    <div className={`rounded-lg border ${cls} p-4`}>
      <div className="text-xs text-slate-500 mb-1">{label}</div>
      <div className="text-2xl font-semibold text-slate-900 tabular-nums">{value}</div>
    </div>
  );
}
