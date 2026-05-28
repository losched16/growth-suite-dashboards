// /admin/billing-status — operator-only "billing health" view.
//
// Surfaces every tenant's dry-run vs live status, days in dry-run,
// draft/open/paid invoice counts, Stripe connection status, and the
// school's support email. Designed to catch stalled onboardings at
// scale: when you're bringing on 100+ schools, the operator needs a
// fast scan to see "who's been in dry-run too long" or "who connected
// Stripe but never published their plans."
//
// Gated behind /admin/* → operator password (proxy.ts).

import Link from 'next/link';
import { ArrowLeft, AlertCircle, CheckCircle2 } from 'lucide-react';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface SchoolBillingRow {
  id: string;
  name: string;
  ghl_location_id: string;
  created_at: Date;
  support_email: string | null;
  billing_active: boolean;
  billing_activated_at: Date | null;
  billing_activated_by_email: string | null;
  stripe_account_id: string | null;
  stripe_charges_enabled: boolean | null;
  stripe_payouts_enabled: boolean | null;
  active_enrollments: number;
  draft_invoices: number;
  open_invoices: number;
  paid_invoices: number;
  voided_invoices: number;
  collected_cents: number;
}

const STUCK_DAYS_THRESHOLD = 30;

export default async function BillingStatusPage() {
  const { rows } = await query<SchoolBillingRow>(
    `SELECT
       s.id, s.name, s.ghl_location_id, s.created_at,
       b.support_email,
       COALESCE(spc.billing_active, false) AS billing_active,
       spc.billing_activated_at,
       spc.billing_activated_by_email,
       pa.stripe_account_id,
       pa.charges_enabled    AS stripe_charges_enabled,
       pa.payouts_enabled    AS stripe_payouts_enabled,
       (SELECT COUNT(*)::int FROM family_tuition_enrollments e
         WHERE e.school_id = s.id AND e.status = 'active') AS active_enrollments,
       (SELECT COUNT(*)::int FROM invoices i
         WHERE i.school_id = s.id AND i.status = 'draft') AS draft_invoices,
       (SELECT COUNT(*)::int FROM invoices i
         WHERE i.school_id = s.id AND i.status = 'open') AS open_invoices,
       (SELECT COUNT(*)::int FROM invoices i
         WHERE i.school_id = s.id AND i.status = 'paid') AS paid_invoices,
       (SELECT COUNT(*)::int FROM invoices i
         WHERE i.school_id = s.id AND i.status = 'voided') AS voided_invoices,
       (SELECT COALESCE(SUM(i.amount_paid_cents), 0)::bigint FROM invoices i
         WHERE i.school_id = s.id) AS collected_cents
       FROM schools s
       LEFT JOIN school_payment_config spc ON spc.school_id = s.id
       LEFT JOIN school_branding b        ON b.school_id = s.id
       LEFT JOIN payment_accounts pa      ON pa.school_id = s.id
      ORDER BY
        COALESCE(spc.billing_active, false) ASC,   -- dry-run first
        s.created_at DESC`,
  );

  const dryRunCount = rows.filter((r) => !r.billing_active).length;
  const liveCount = rows.length - dryRunCount;
  const stuckCount = rows.filter((r) =>
    !r.billing_active && daysSince(r.created_at) >= STUCK_DAYS_THRESHOLD,
  ).length;

  return (
    <main className="flex flex-1 flex-col items-center bg-slate-50 p-6 min-h-screen">
      <div className="w-full max-w-7xl space-y-4">
        <Link
          href="/admin"
          className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"
        >
          <ArrowLeft className="h-3 w-3" /> Back to school list
        </Link>

        <header>
          <h1 className="text-2xl font-semibold text-slate-900">Billing Status</h1>
          <p className="mt-1 text-sm text-slate-500">
            Every tenant&rsquo;s dry-run / live status at a glance. Catch stalled onboardings before
            the school does.
          </p>
        </header>

        {/* Top KPIs */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Total schools" value={String(rows.length)} />
          <StatCard label="Live" value={String(liveCount)} accent="emerald" />
          <StatCard label="Dry-run" value={String(dryRunCount)} accent="amber" />
          <StatCard
            label={`Stuck >${STUCK_DAYS_THRESHOLD}d`}
            value={String(stuckCount)}
            accent={stuckCount > 0 ? 'rose' : 'slate'}
            hint={stuckCount > 0 ? 'Follow up with these' : 'No stalled schools'}
          />
        </div>

        {/* Table */}
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200 text-left text-[10px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2.5 font-semibold">School</th>
                <th className="px-3 py-2.5 font-semibold">Status</th>
                <th className="px-3 py-2.5 font-semibold">Days</th>
                <th className="px-3 py-2.5 font-semibold">Stripe</th>
                <th className="px-3 py-2.5 font-semibold text-right">Enrollments</th>
                <th className="px-3 py-2.5 font-semibold text-right">Draft / Open / Paid</th>
                <th className="px-3 py-2.5 font-semibold text-right">Collected</th>
                <th className="px-3 py-2.5 font-semibold">Contact</th>
                <th className="px-3 py-2.5 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.length === 0 ? (
                <tr><td colSpan={9} className="p-10 text-center text-slate-500 italic">No schools provisioned yet.</td></tr>
              ) : rows.map((r) => {
                const ageDays = daysSince(r.created_at);
                const isStuck = !r.billing_active && ageDays >= STUCK_DAYS_THRESHOLD;
                const liveDays = r.billing_activated_at ? daysSince(r.billing_activated_at) : null;

                return (
                  <tr key={r.id} className={`hover:bg-slate-50 ${isStuck ? 'bg-rose-50/40' : ''}`}>
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-slate-900">{r.name}</div>
                      <div className="text-[11px] text-slate-500 font-mono">{r.ghl_location_id}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      {r.billing_active ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-800">
                          <CheckCircle2 className="h-3 w-3" /> LIVE
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
                          {isStuck ? <AlertCircle className="h-3 w-3" /> : null}
                          DRY-RUN
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-700 tabular-nums">
                      {r.billing_active ? (
                        <span title={`Activated ${r.billing_activated_at?.toLocaleDateString()}`}>
                          {liveDays}d live
                        </span>
                      ) : (
                        <span className={isStuck ? 'font-bold text-rose-700' : 'text-slate-700'}
                              title={`Created ${r.created_at.toLocaleDateString()}`}>
                          {ageDays}d {isStuck ? 'stuck' : 'on platform'}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <StripeBadge
                        accountId={r.stripe_account_id}
                        charges={r.stripe_charges_enabled}
                        payouts={r.stripe_payouts_enabled}
                      />
                    </td>
                    <td className="px-3 py-2.5 text-right text-xs tabular-nums">
                      {r.active_enrollments}
                    </td>
                    <td className="px-3 py-2.5 text-right text-xs tabular-nums">
                      <span className="text-amber-700">{r.draft_invoices}</span>
                      <span className="text-slate-300 mx-1">/</span>
                      <span className="text-blue-700">{r.open_invoices}</span>
                      <span className="text-slate-300 mx-1">/</span>
                      <span className="text-emerald-700">{r.paid_invoices}</span>
                    </td>
                    <td className="px-3 py-2.5 text-right text-xs tabular-nums font-semibold text-slate-900">
                      {fmtUsd(r.collected_cents)}
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      {r.support_email ? (
                        <a href={`mailto:${r.support_email}`} className="text-blue-600 hover:underline truncate block max-w-[200px]">
                          {r.support_email}
                        </a>
                      ) : (
                        <span className="text-slate-400 italic">no email</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Link
                        href={`/admin/${r.id}/payments`}
                        className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
                      >
                        Open Payments
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Footnote */}
        <p className="text-[11px] text-slate-500">
          <strong className="text-rose-700">Stuck</strong> = dry-run for {STUCK_DAYS_THRESHOLD}+ days
          since the school was added to the platform. These schools usually need a follow-up call to
          unblock whatever&rsquo;s preventing them from going live. Order: dry-run first (oldest at the
          top), then live schools by recency.
        </p>
      </div>
    </main>
  );
}

// ── Helpers ────────────────────────────────────────────────────────

function daysSince(d: Date): number {
  return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
}

function fmtUsd(cents: number | string): string {
  const n = typeof cents === 'string' ? Number(cents) : cents;
  if (!Number.isFinite(n) || n === 0) return '$0';
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  }).format(n / 100);
}

function StatCard({
  label, value, hint, accent,
}: {
  label: string; value: string; hint?: string;
  accent?: 'emerald' | 'amber' | 'rose' | 'slate';
}) {
  const accentCls =
    accent === 'emerald' ? 'bg-emerald-50 border-emerald-200' :
    accent === 'amber'   ? 'bg-amber-50   border-amber-200'   :
    accent === 'rose'    ? 'bg-rose-50    border-rose-200'    :
                           'bg-white      border-slate-200';
  return (
    <div className={`rounded-lg border ${accentCls} px-4 py-3`}>
      <div className="text-[11px] uppercase tracking-wide text-slate-500 font-medium">{label}</div>
      <div className="text-2xl font-bold text-slate-900 tabular-nums mt-0.5">{value}</div>
      {hint ? <div className="text-[11px] text-slate-500 mt-0.5">{hint}</div> : null}
    </div>
  );
}

function StripeBadge({
  accountId, charges, payouts,
}: { accountId: string | null; charges: boolean | null; payouts: boolean | null }) {
  if (!accountId) {
    return <span className="text-[10px] text-slate-400 italic">not connected</span>;
  }
  if (charges && payouts) {
    return <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800">connected</span>;
  }
  return <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">setup pending</span>;
}
