// Financial Reports widget. Mirrors the bespoke DG finance dashboard:
// top-line cards, tuition-by-program, other revenue lines, enrichment
// and sports breakdowns, discounts, aid + credits, recipient lists,
// "actual cash data coming with Smart Payments" placeholder.

import type { WidgetDefinition, SchoolContext, WidgetSearchParams } from '@/lib/widgets/types';
import {
  financeDashboardDefaults,
  financeDashboardSchema,
  type FinanceDashboardConfig,
} from './config';
import {
  fetcher, type FinanceData, type RecipientRow, type FactsActuals, type LivePayments,
  type StudentProgressRow, type TransactionRow,
} from './fetcher';
import { DownloadCsvButton } from '@/components/DownloadCsvButton';
import { AutoSubmitForm } from '@/lib/widgets/components/_shared/AutoSubmitForm';
import { PreserveEmbedParams } from '@/lib/widgets/components/_shared/PreserveEmbedParams';
import Link from 'next/link';

function fmt(n: number): string {
  return n === 0 ? '$0' : `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
function fmtSmall(n: number): string {
  return n === 0 ? '$0' : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function BigCard({ label, value, accent, sub }: {
  label: string;
  value: string;
  accent: 'emerald' | 'rose' | 'amber';
  sub?: string;
}) {
  const accents = { emerald: 'text-emerald-700', rose: 'text-rose-700', amber: 'text-amber-700' };
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className={`text-2xl font-bold tabular-nums ${accents[accent]}`}>{value}</div>
      <div className="mt-0.5 text-xs uppercase tracking-wide text-gray-500">{label}</div>
      {sub ? <div className="mt-0.5 text-[11px] text-gray-400">{sub}</div> : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-gray-200 bg-white overflow-hidden">
      <div className="border-b border-gray-100 bg-gray-50 px-4 py-2">
        <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
      </div>
      <table className="w-full">{children}</table>
    </section>
  );
}

function TableHead({ cols, rightCols }: { cols: string[]; rightCols?: number[] }) {
  return (
    <thead className="bg-gray-50 border-b border-gray-100 text-left text-[11px] uppercase tracking-wide text-gray-500">
      <tr>
        {cols.map((c, i) => (
          <th key={c} className={`px-3 py-2 font-medium ${rightCols?.includes(i) ? 'text-right' : ''}`}>{c}</th>
        ))}
      </tr>
    </thead>
  );
}

function LineRow({ label, value }: { label: string; value: number }) {
  return (
    <tr className="text-sm">
      <td className="px-3 py-2 text-gray-700">{label}</td>
      <td className="px-3 py-2 text-right tabular-nums font-medium">{fmtSmall(value)}</td>
    </tr>
  );
}

function RecipientList({
  title, count, total, items, emptyHint,
}: {
  title: string;
  count: number;
  total: number;
  items: RecipientRow[];
  emptyHint?: string;
}) {
  return (
    <section className="rounded-lg border border-gray-200 bg-white">
      <div className="border-b border-gray-100 bg-gray-50 px-4 py-2 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
        <span className="text-xs text-gray-500">{count} · {fmt(total)}</span>
      </div>
      {items.length === 0 ? (
        <div className="px-4 py-4 text-center text-xs text-gray-500">
          None yet.{emptyHint ? <div className="mt-1 italic">{emptyHint}</div> : null}
        </div>
      ) : (
        <ul className="divide-y divide-gray-100 max-h-72 overflow-y-auto">
          {items.map((it, i) => (
            <li key={i} className="px-3 py-2 flex items-baseline justify-between gap-2 text-sm">
              <div className="min-w-0">
                <div className="font-medium text-gray-900 truncate">{it.name}</div>
                <div className="text-[11px] text-gray-500 truncate">{it.sub}</div>
              </div>
              <span className="tabular-nums font-medium text-gray-900">{fmt(it.amount)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Component({
  school,
  config,
  data,
  searchParams,
}: {
  school: SchoolContext;
  config: FinanceDashboardConfig;
  data: FinanceData;
  searchParams?: WidgetSearchParams;
}) {
  const showRecipients = config.show_recipient_lists !== false;
  const current = searchParams ?? {};

  const exportBase = `/api/export/finance/${school.locationId}`;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold text-emerald-800">Finance Hub — {school.schoolName}</h2>
          <p className="mt-1 text-sm text-gray-600">
            2026–2027 school year · actual cash from FACTS + Growth Suite billing · {data.student_count} active students
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-medium text-gray-500">Download:</span>
          <DownloadCsvButton href={`/api/export/facts-ledger/${school.locationId}`} label="Transactions (by account)" size="xs" />
          <DownloadCsvButton href={`/api/export/facts/${school.locationId}`} label="Per-student rollup" size="xs" />
          <DownloadCsvButton href={exportBase} label="Contracted revenue" size="xs" />
        </div>
      </div>

      <TabNav active={data.fin_tab} current={current} />

      {data.fin_tab === 'students' ? <StudentsTab data={data} school={school} current={current} /> : null}
      {data.fin_tab === 'transactions' ? <TransactionsTab data={data} school={school} current={current} /> : null}

      {data.fin_tab === 'overview' ? (
      <div className="space-y-5">
        {data.facts ? <FactsActualsSection facts={data.facts} school={school} /> : null}
        {data.live_payments ? <LivePaymentsSection live={data.live_payments} /> : null}
        <BillingActions school={school} />
        <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-[11px] text-gray-600">
          The tables below are <em>contracted / projected</em> revenue from enrollment records (full-year totals).
          Actual cash charged and collected to date is in the cards above.
        </div>

      {/* Top-line */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <BigCard label="Gross revenue (contracted)" value={fmt(data.total_revenue)} accent="emerald" sub={`across ${data.student_count} students`} />
        <BigCard label="Total discounts" value={fmt(data.total_discounts)} accent="rose" sub="emp + annual + sibling" />
        <BigCard label="Total aid + credits" value={fmt(data.total_aid_credits)} accent="amber" sub="fin aid + ESA + STO + referral" />
        <BigCard label="Net revenue" value={fmt(data.net_revenue)} accent="emerald" sub="gross − discounts − aid" />
      </div>

      {/* Tuition by program */}
      <Section title="Tuition Revenue by program">
        <TableHead cols={['Program', 'Students', 'Tuition']} rightCols={[1, 2]} />
        <tbody className="divide-y divide-gray-100">
          {data.by_program.map((p) => (
            <tr key={p.label} className="text-sm">
              <td className="px-3 py-2 font-medium text-gray-900">{p.label}</td>
              <td className="px-3 py-2 text-right tabular-nums text-gray-700">{p.count}</td>
              <td className="px-3 py-2 text-right tabular-nums font-semibold text-gray-900">{fmt(p.tuition)}</td>
            </tr>
          ))}
          <tr className="bg-gray-50 text-sm font-semibold">
            <td className="px-3 py-2">Total Tuition</td>
            <td className="px-3 py-2 text-right tabular-nums">{data.student_count}</td>
            <td className="px-3 py-2 text-right tabular-nums text-emerald-700">{fmt(data.total_tuition)}</td>
          </tr>
        </tbody>
      </Section>

      {/* Other revenue lines */}
      <Section title="Other revenue lines">
        <TableHead cols={['Line item', 'Total']} rightCols={[1]} />
        <tbody className="divide-y divide-gray-100">
          <LineRow label="Enrollment Fee Revenue" value={data.enrollment_fee} />
          <LineRow label="Admin Fee Revenue" value={data.admin_fee} />
          <LineRow label="Extended Day Revenue" value={data.extended_day} />
          <LineRow label="Paid Organic Lunch Revenue" value={data.lunch} />
          <LineRow label="SST Revenue" value={data.sst} />
          <LineRow label="Enrichments Revenue (all classes)" value={data.enrichments_total} />
          <LineRow label="Sports Revenue (all sports)" value={data.sports_total} />
          <LineRow label="Late Fee Revenue" value={data.late_fees} />
        </tbody>
      </Section>

      {/* Enrichments + Sports breakdowns */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Section title="Enrichments Revenue — by class">
          <TableHead cols={['Class', 'Students', 'Revenue']} rightCols={[1, 2]} />
          <tbody className="divide-y divide-gray-100">
            {data.by_enrichment.length === 0 ? (
              <tr><td colSpan={3} className="px-3 py-4 text-center text-sm text-gray-500">No enrichment data yet</td></tr>
            ) : data.by_enrichment.map((e) => (
              <tr key={e.label} className="text-sm">
                <td className="px-3 py-2 text-gray-900">{e.label}</td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-700">{e.count}</td>
                <td className="px-3 py-2 text-right tabular-nums font-medium">{fmt(e.revenue)}</td>
              </tr>
            ))}
          </tbody>
        </Section>
        <Section title="Sports Revenue — by sport">
          <TableHead cols={['Sport', 'Students', 'Revenue']} rightCols={[1, 2]} />
          <tbody className="divide-y divide-gray-100">
            {data.by_sport.length === 0 ? (
              <tr><td colSpan={3} className="px-3 py-4 text-center text-sm text-gray-500">No sports data yet</td></tr>
            ) : data.by_sport.map((s) => (
              <tr key={s.label} className="text-sm">
                <td className="px-3 py-2 text-gray-900">{s.label}</td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-700">{s.count}</td>
                <td className="px-3 py-2 text-right tabular-nums font-medium">{fmt(s.revenue)}</td>
              </tr>
            ))}
          </tbody>
        </Section>
      </div>

      {/* Discounts + Aid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Section title="Discounts">
          <TableHead cols={['Discount type', 'Total']} rightCols={[1]} />
          <tbody className="divide-y divide-gray-100">
            <LineRow label="Employee Discounts" value={data.employee_discount} />
            <LineRow label="Annual Discounts" value={data.annual_discount} />
            <LineRow label="Sibling Discounts" value={data.sibling_discount} />
            <tr className="bg-rose-50 text-sm font-semibold">
              <td className="px-3 py-2">Total Discounts</td>
              <td className="px-3 py-2 text-right tabular-nums text-rose-800">{fmt(data.total_discounts)}</td>
            </tr>
          </tbody>
        </Section>
        <Section title="Aid & credits">
          <TableHead cols={['Type', 'Total']} rightCols={[1]} />
          <tbody className="divide-y divide-gray-100">
            <LineRow label="Financial Aid Awards" value={data.financial_aid} />
            <LineRow label="Referral Credits" value={data.referral_credit} />
            <LineRow label="ESA Payments" value={data.esa} />
            <LineRow label="STO Payments — Original" value={data.sto_orig} />
            <LineRow label="STO Payments — Switcher" value={data.sto_switcher} />
            <LineRow label="STO Payments — Corporate" value={data.sto_corp} />
            {data.sto_other > 0 ? <LineRow label="STO Payments — Other / unspecified" value={data.sto_other} /> : null}
            <tr className="bg-amber-50 text-sm font-semibold">
              <td className="px-3 py-2">Total Aid + Credits</td>
              <td className="px-3 py-2 text-right tabular-nums text-amber-900">{fmt(data.total_aid_credits)}</td>
            </tr>
          </tbody>
        </Section>
      </div>

      {/* Recipient lists */}
      {showRecipients ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <RecipientList title="Financial Aid Recipients" count={data.fin_aid_recipients.length} total={data.financial_aid} items={data.fin_aid_recipients} />
          <RecipientList title="ESA Recipients" count={data.esa_recipients.length} total={data.esa} items={data.esa_recipients} emptyHint="Add esa_recipient / esa_amount fields on the contact record" />
          <RecipientList title="STO Recipients" count={data.sto_recipients.length} total={data.sto_orig + data.sto_switcher + data.sto_corp + data.sto_other} items={data.sto_recipients} emptyHint="Add sto_recipient / sto_type / sto_amount fields on the contact record" />
        </div>
      ) : null}

      </div>
      ) : null}
    </div>
  );
}

// Renders the native (non-FACTS) cash + contracted-revenue figures.
// Sources: invoices + family_tuition_enrollments tables (the platform's
// own books). For tenants on the new tuition stack this is the source
// of truth; for legacy DGM-style tenants this surfaces alongside the
// FACTS section below.
function LivePaymentsSection({ live }: { live: LivePayments }) {
  const fmt = (cents: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
      .format(cents / 100);
  const collectedPct = live.total_billed_cents > 0
    ? Math.round((live.total_paid_cents / live.total_billed_cents) * 100)
    : 0;

  return (
    <div className="rounded-lg border-2 border-blue-300 bg-blue-50/40 p-4">
      <div className="flex items-baseline justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-bold text-blue-900">💳 Live cash flow (platform tuition system)</h2>
          <p className="text-xs text-blue-800">
            Pulled from your invoices + active enrollments. Refreshes every time a parent pays.
          </p>
        </div>
        <span className="text-[11px] text-blue-700 italic">{live.active_enrollments} active enrollments</span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card label="Contracted annual" value={fmt(live.total_annual_contracted_cents)} hint="Sum of all active plans" />
        <Card label="Billed to date"    value={fmt(live.total_billed_cents)}            hint={`${live.total_invoices - live.voided_invoices} invoices`} />
        <Card label="Collected"         value={fmt(live.total_paid_cents)}              hint={`${collectedPct}% of billed`} accent="emerald" />
        <Card label="Outstanding"       value={fmt(live.total_outstanding_cents)}       hint={`${live.open_invoices + live.partially_paid_invoices} unpaid`} accent={live.total_outstanding_cents === 0 ? 'emerald' : 'amber'} />
      </div>

      <div className="mt-3 flex items-center gap-3 text-[11px] text-blue-800 flex-wrap">
        <span><strong>{live.paid_invoices}</strong> paid</span>
        <span>·</span>
        <span><strong>{live.partially_paid_invoices}</strong> partial</span>
        <span>·</span>
        <span><strong>{live.open_invoices}</strong> open</span>
        {live.voided_invoices > 0 ? (
          <>
            <span>·</span>
            <span><strong>{live.voided_invoices}</strong> voided</span>
          </>
        ) : null}
      </div>
    </div>
  );
}

// Small KPI card used by LivePaymentsSection. Doesn't share with the
// existing Card variants because those expect dollar-denominated metadata
// values, not cents.
function Card({ label, value, hint, accent }: {
  label: string;
  value: string;
  hint?: string;
  accent?: 'emerald' | 'amber' | 'rose';
}) {
  const accentCls =
    accent === 'emerald' ? 'border-emerald-300 bg-emerald-50' :
    accent === 'amber'   ? 'border-amber-300 bg-amber-50' :
    accent === 'rose'    ? 'border-rose-300 bg-rose-50' :
                           'border-slate-200 bg-white';
  return (
    <div className={`rounded-md border ${accentCls} px-3 py-2`}>
      <div className="text-[10px] uppercase tracking-wide text-slate-500 font-medium">{label}</div>
      <div className="text-xl font-semibold text-slate-900 tabular-nums mt-0.5">{value}</div>
      {hint ? <div className="text-[11px] text-slate-500 mt-0.5">{hint}</div> : null}
    </div>
  );
}

function FactsActualsSection({ facts, school }: { facts: FactsActuals; school: SchoolContext }) {
  const collectionRate = facts.charges > 0 ? (facts.payments / facts.charges) * 100 : 0;

  return (
    <div className="space-y-4">
      {/* Header card */}
      <div className="rounded-lg border-2 border-emerald-300 bg-emerald-50 p-4">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-lg font-bold text-emerald-900">💰 Actual cash position — {facts.term}</h2>
            <p className="mt-0.5 text-xs text-emerald-800">
              Imported FACTS charges &amp; payments · {facts.matched_to_students} students, all matched
              {facts.imported_at ? ` · updated ${new Date(facts.imported_at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}` : ''}
            </p>
          </div>
        </div>
      </div>

      {/* Big-number cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <BigCard label="Total charged" value={fmt(facts.charges)} accent="emerald" sub="2026–2027 to date" />
        <BigCard label="Collected to date" value={fmt(facts.payments)} accent="emerald" sub={`${collectionRate.toFixed(1)}% of charges`} />
        <BigCard label="Outstanding balance" value={fmt(facts.amount_due)} accent="amber" sub={`${facts.ar_buckets.owes_under_500 + facts.ar_buckets.owes_500_2000 + facts.ar_buckets.owes_2000_5000 + facts.ar_buckets.owes_over_5000} families owe`} />
        <BigCard label="Credits & discounts" value={fmt(facts.credits)} accent="rose" sub="applied to accounts" />
      </div>

      {/* Outstanding-balance buckets */}
      <Section title="Outstanding balances — families by amount owed">
        <thead className="bg-gray-50 border-b border-gray-100 text-left text-[11px] uppercase tracking-wide text-gray-500">
          <tr>
            <th className="px-3 py-2 font-medium">Bucket</th>
            <th className="px-3 py-2 font-medium text-right">Accounts</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 text-sm">
          <tr><td className="px-3 py-2 text-emerald-700 font-medium">Paid in full</td><td className="px-3 py-2 text-right tabular-nums font-medium text-emerald-700">{facts.ar_buckets.paid_in_full}</td></tr>
          <tr><td className="px-3 py-2 text-gray-700">Owes under $500</td><td className="px-3 py-2 text-right tabular-nums">{facts.ar_buckets.owes_under_500}</td></tr>
          <tr><td className="px-3 py-2 text-gray-700">Owes $500–$2,000</td><td className="px-3 py-2 text-right tabular-nums">{facts.ar_buckets.owes_500_2000}</td></tr>
          <tr><td className="px-3 py-2 text-amber-700">Owes $2,000–$5,000</td><td className="px-3 py-2 text-right tabular-nums text-amber-700">{facts.ar_buckets.owes_2000_5000}</td></tr>
          <tr><td className="px-3 py-2 text-rose-700 font-medium">Owes over $5,000</td><td className="px-3 py-2 text-right tabular-nums font-medium text-rose-700">{facts.ar_buckets.owes_over_5000}</td></tr>
        </tbody>
      </Section>

      {/* Top outstanding */}
      <section className="rounded-lg border border-gray-200 bg-white overflow-hidden">
        <div className="flex items-baseline justify-between border-b border-gray-100 bg-gray-50 px-4 py-2">
          <h2 className="text-sm font-semibold text-gray-900">Top outstanding accounts</h2>
          <span className="text-xs text-gray-500">sorted by amount owed</span>
        </div>
        {facts.top_delinquent.length === 0 ? (
          <div className="p-6 text-center text-sm text-emerald-700">🎉 Everyone is paid in full!</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100 text-left text-[11px] uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2 font-medium">Family</th>
                <th className="px-3 py-2 font-medium">Student</th>
                <th className="px-3 py-2 font-medium text-right">Charged</th>
                <th className="px-3 py-2 font-medium text-right">Paid</th>
                <th className="px-3 py-2 font-medium text-right">Outstanding</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {facts.top_delinquent.slice(0, 15).map((r, i) => (
                <tr key={i} className={r.delinquent_balance > 0 ? 'bg-rose-50/40' : ''}>
                  <td className="px-3 py-2 text-gray-900 font-medium">
                    {r.matched_family_id ? (
                      <Link href={`/school/${school.locationId}/family-hub/${r.matched_family_id}`} className="text-emerald-700 hover:underline">
                        {r.customer_name}
                      </Link>
                    ) : (
                      <span title="Not matched to a family in our system">{r.customer_name} <span className="text-[10px] text-amber-700">⚠</span></span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-gray-700">{r.student_name}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-700">{fmt(r.charges)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-700">{fmt(r.payments)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums font-semibold ${r.amount_due > 5000 ? 'text-rose-700' : 'text-amber-700'}`}>{fmt(r.amount_due)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

// ── Finance Hub tabs ──────────────────────────────────────────────────

const FIN_TABS: Array<{ key: FinanceData['fin_tab']; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'students', label: 'Students & Families' },
  { key: 'transactions', label: 'Transactions' },
];

function tabHref(current: WidgetSearchParams, tab: string): string {
  const keep: Record<string, string> = {};
  if (current.chrome) keep.chrome = current.chrome;
  if (current.embed_token) keep.embed_token = current.embed_token;
  keep.fintab = tab;
  return `?${new URLSearchParams(keep).toString()}`;
}

function TabNav({ active, current }: { active: FinanceData['fin_tab']; current: WidgetSearchParams }) {
  return (
    <div className="flex items-center gap-1 border-b border-gray-200">
      {FIN_TABS.map((t) => (
        <a
          key={t.key}
          href={tabHref(current, t.key)}
          className={`px-4 py-2 text-sm font-medium -mb-px border-b-2 ${
            active === t.key
              ? 'border-emerald-600 text-emerald-800'
              : 'border-transparent text-gray-500 hover:text-gray-800'
          }`}
        >
          {t.label}
        </a>
      ))}
    </div>
  );
}

function BillingActions({ school }: { school: SchoolContext }) {
  const base = `/school/${school.locationId}/payments`;
  const link = 'rounded-md border border-emerald-300 bg-white px-3 py-1.5 text-xs font-medium text-emerald-800 hover:bg-emerald-100';
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2.5">
      <span className="text-xs font-semibold text-emerald-900">Billing:</span>
      <Link href={`${base}?tab=plans`} className={link}>Tuition plans &amp; schedules</Link>
      <Link href={`${base}/bulk-tuition`} className={link}>Schedule tuition (bulk)</Link>
      <Link href={`${base}?tab=invoices`} className={link}>Invoices</Link>
      <Link href={`${base}?tab=settings`} className={link}>Payment settings</Link>
    </div>
  );
}

function StudentsTab({ data, school, current }: { data: FinanceData; school: SchoolContext; current: WidgetSearchParams }) {
  const rows = data.students ?? [];
  const totalPaid = rows.reduce((a, r) => a + r.paid, 0);
  const totalBalance = rows.reduce((a, r) => a + r.balance, 0);
  return (
    <div className="space-y-3">
      <AutoSubmitForm className="flex flex-wrap items-end gap-2">
        <PreserveEmbedParams current={current} />
        <input type="hidden" name="fintab" value="students" />
        <label className="block">
          <span className="text-[10px] uppercase tracking-wide text-gray-500">Search student or family</span>
          <input type="text" name="q" defaultValue={data.q} placeholder="Name…" className="mt-0.5 block w-56 rounded border border-gray-300 px-2 py-1.5 text-sm" />
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-wide text-gray-500">Show</span>
          <select name="status" defaultValue={data.status} className="mt-0.5 block rounded border border-gray-300 px-2 py-1.5 text-sm">
            <option value="">All students</option>
            <option value="balance">Has a balance</option>
            <option value="paid">Paid in full</option>
            <option value="no_facts">No FACTS history</option>
          </select>
        </label>
        <noscript><button type="submit" className="rounded bg-emerald-600 px-3 py-1.5 text-sm text-white">Apply</button></noscript>
        <span className="ml-auto text-xs text-gray-500">{rows.length} students · paid {fmtSmall(totalPaid)} · balance {fmtSmall(totalBalance)}</span>
      </AutoSubmitForm>

      <section className="rounded-lg border border-gray-200 bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-100 text-left text-[11px] uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-3 py-2 font-medium">Student</th>
              <th className="px-3 py-2 font-medium">Family</th>
              <th className="px-3 py-2 font-medium">Plan</th>
              <th className="px-3 py-2 font-medium text-right">Charged</th>
              <th className="px-3 py-2 font-medium text-right">Paid</th>
              <th className="px-3 py-2 font-medium text-right">Balance</th>
              <th className="px-3 py-2 font-medium">Progress</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.length === 0 ? (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-gray-500">No students match.</td></tr>
            ) : rows.map((r) => (
              <tr key={r.student_id}>
                <td className="px-3 py-2 font-medium text-gray-900">
                  {r.family_id ? (
                    <Link href={`/school/${school.locationId}/family-hub/${r.family_id}`} className="text-emerald-700 hover:underline">{r.student_name}</Link>
                  ) : r.student_name}
                  {r.program ? <div className="text-[11px] text-gray-500">{r.program}</div> : null}
                </td>
                <td className="px-3 py-2 text-gray-700">{r.family}</td>
                <td className="px-3 py-2 text-xs text-gray-600">{r.plan || '—'}{r.gs_installments > 0 ? <span className="text-gray-400"> · {r.gs_installments} pmts</span> : null}</td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-700">{fmtSmall(r.charged)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-emerald-700">{fmtSmall(r.paid)}</td>
                <td className={`px-3 py-2 text-right tabular-nums font-semibold ${r.balance > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>{fmtSmall(r.balance)}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-24 rounded-full bg-gray-200 overflow-hidden">
                      <div className="h-full bg-emerald-500" style={{ width: `${r.pct_paid}%` }} />
                    </div>
                    <span className="text-[11px] text-gray-500 tabular-nums">{r.pct_paid}%</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <p className="text-[11px] text-gray-500">Charged / Paid / Balance are actuals from FACTS. “Paid” updates from Growth Suite autopay once you go live. Click a student to open their family record. Showing up to 1,000 students.</p>
    </div>
  );
}

function TransactionsTab({ data, school, current }: { data: FinanceData; school: SchoolContext; current: WidgetSearchParams }) {
  const rows = data.transactions ?? [];
  const tot = rows.reduce((acc, r) => { acc.ch += r.charged; acc.cr += r.credit; acc.pay += r.paid; acc.bal += r.balance; return acc; }, { ch: 0, cr: 0, pay: 0, bal: 0 });
  return (
    <div className="space-y-3">
      <AutoSubmitForm className="flex flex-wrap items-end gap-2">
        <PreserveEmbedParams current={current} />
        <input type="hidden" name="fintab" value="transactions" />
        <label className="block">
          <span className="text-[10px] uppercase tracking-wide text-gray-500">Account</span>
          <select name="acct" defaultValue={data.acct} className="mt-0.5 block rounded border border-gray-300 px-2 py-1.5 text-sm">
            <option value="">All accounts</option>
            {data.account_options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-wide text-gray-500">Search student</span>
          <input type="text" name="q" defaultValue={data.q} placeholder="Name…" className="mt-0.5 block w-56 rounded border border-gray-300 px-2 py-1.5 text-sm" />
        </label>
        <noscript><button type="submit" className="rounded bg-emerald-600 px-3 py-1.5 text-sm text-white">Apply</button></noscript>
        <a href={`/api/export/facts-ledger/${school.locationId}`} className="ml-auto rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">Download all (CSV)</a>
      </AutoSubmitForm>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Card label="Charged" value={fmtSmall(tot.ch)} />
        <Card label="Credits" value={fmtSmall(tot.cr)} />
        <Card label="Paid" value={fmtSmall(tot.pay)} accent="emerald" />
        <Card label="Balance" value={fmtSmall(tot.bal)} accent="amber" />
      </div>

      <section className="rounded-lg border border-gray-200 bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-100 text-left text-[11px] uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-3 py-2 font-medium">Student</th>
              <th className="px-3 py-2 font-medium">Family</th>
              <th className="px-3 py-2 font-medium">Account</th>
              <th className="px-3 py-2 font-medium text-right">Charged</th>
              <th className="px-3 py-2 font-medium text-right">Credit</th>
              <th className="px-3 py-2 font-medium text-right">Paid</th>
              <th className="px-3 py-2 font-medium text-right">Balance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.length === 0 ? (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-gray-500">No transactions match.</td></tr>
            ) : rows.map((r, i) => (
              <tr key={i}>
                <td className="px-3 py-2 text-gray-900">{r.student_name}</td>
                <td className="px-3 py-2 text-gray-600">{r.family}</td>
                <td className="px-3 py-2 text-gray-700">{r.account}</td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-700">{r.charged ? fmtSmall(r.charged) : '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-500">{r.credit ? fmtSmall(r.credit) : '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums text-emerald-700">{r.paid ? fmtSmall(r.paid) : '—'}</td>
                <td className={`px-3 py-2 text-right tabular-nums font-medium ${r.balance > 0 ? 'text-amber-700' : 'text-gray-400'}`}>{r.balance ? fmtSmall(r.balance) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <p className="text-[11px] text-gray-500">FACTS ledger lines for 2026–2027 — every charge, credit, and payment by account. Showing up to 1,000 rows; use Download for the full set.</p>
    </div>
  );
}

export const FinanceDashboard: WidgetDefinition<FinanceDashboardConfig, FinanceData> = {
  id: 'finance_dashboard',
  display_name: 'Finance Hub',
  description: 'Cash position, student payment progress, and transactions — actuals from FACTS + Growth Suite billing.',
  category: 'billing',
  default_config: financeDashboardDefaults,
  config_schema: financeDashboardSchema,
  default_size: { w: 12, h: 12 },
  Component,
  dataFetcher: fetcher,
  searchParamsAffectFetch: true,
};
