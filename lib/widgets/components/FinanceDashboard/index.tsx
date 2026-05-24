// Financial Reports widget. Mirrors the bespoke DG finance dashboard:
// top-line cards, tuition-by-program, other revenue lines, enrichment
// and sports breakdowns, discounts, aid + credits, recipient lists,
// "actual cash data coming with Smart Payments" placeholder.

import type { WidgetDefinition, SchoolContext } from '@/lib/widgets/types';
import {
  financeDashboardDefaults,
  financeDashboardSchema,
  type FinanceDashboardConfig,
} from './config';
import { fetcher, type FinanceData, type RecipientRow, type FactsActuals } from './fetcher';
import { DownloadCsvButton } from '@/components/DownloadCsvButton';
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
}: {
  school: SchoolContext;
  config: FinanceDashboardConfig;
  data: FinanceData;
}) {
  const showPlaceholder = config.show_actual_payments_placeholder !== false;
  const showRecipients = config.show_recipient_lists !== false;

  const exportBase = `/api/export/finance/${school.locationId}`;

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-2xl font-bold text-emerald-800">
              Financial Reports — {school.schoolName}
            </h2>
            <p className="mt-1 text-sm text-gray-600">
              {data.student_count} students · contracted amounts from each student&apos;s enrollment record
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <DownloadCsvButton href={exportBase} label="Per-student CSV" />
            <DownloadCsvButton href={`${exportBase}?type=program`} label="By program" size="xs" />
            <DownloadCsvButton href={`${exportBase}?type=enrichment`} label="By enrichment" size="xs" />
            <DownloadCsvButton href={`${exportBase}?type=sport`} label="By sport" size="xs" />
            <DownloadCsvButton href={`${exportBase}?type=fin_aid`} label="Fin Aid list" size="xs" />
            <DownloadCsvButton href={`${exportBase}?type=esa`} label="ESA list" size="xs" />
            <DownloadCsvButton href={`${exportBase}?type=sto`} label="STO list" size="xs" />
          </div>
        </div>
        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <strong>Note:</strong> All figures here are <em>projected/contracted</em> revenue from
          enrollment data — not actual cash received. A/R aging, bank balances, returned
          payments, and payment-method issues will appear here once Smart Payments / accounting
          integration is wired in.
        </div>
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

      {/* FACTS actuals — replaces the Coming Soon section once data is imported */}
      {data.facts ? <FactsActualsSection facts={data.facts} school={school} /> : (showPlaceholder ? (
        <Section title="Actual payment data (FACTS import pending)">
          <div className="px-4 py-4 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 text-xs">
            {[
              'A/R Aging',
              'Credit Balances',
              'Payments received',
              'Delinquent balances',
              'Top outstanding accounts',
              'Returned / invalid payment methods',
            ].map((label) => (
              <div key={label} className="rounded-md border border-dashed border-gray-300 bg-white px-3 py-2 text-gray-500">
                {label} <span className="ml-1 italic text-gray-400">— coming</span>
              </div>
            ))}
          </div>
          <div className="px-4 pb-3 text-[11px] text-gray-500">
            To populate: drop FACTS Customer / Student / Balances exports into{' '}
            <code className="font-mono">scripts/import-facts.py</code> for this school.
          </div>
        </Section>
      ) : null)}
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
            <h2 className="text-lg font-bold text-emerald-900">💰 Actual cash flow — {facts.term}</h2>
            <p className="mt-0.5 text-xs text-emerald-800">
              From FACTS Management · {facts.rows} balance rows, {facts.matched_to_students} matched to our students
              {facts.imported_at ? ` · imported ${new Date(facts.imported_at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}` : ''}
            </p>
          </div>
        </div>
      </div>

      {/* Big-number cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <BigCard label="Total charged" value={fmt(facts.charges)} accent="emerald" sub="this school year" />
        <BigCard label="Total payments received" value={fmt(facts.payments)} accent="emerald" sub={`${collectionRate.toFixed(1)}% collection rate`} />
        <BigCard label="Outstanding A/R" value={fmt(facts.amount_due)} accent="amber" sub={`${facts.ar_buckets.delinquent_count + facts.ar_buckets.owes_under_500 + facts.ar_buckets.owes_500_2000 + facts.ar_buckets.owes_2000_5000 + facts.ar_buckets.owes_over_5000} accounts`} />
        <BigCard label="Delinquent balance" value={fmt(facts.delinquent_balance)} accent="rose" sub={`${facts.ar_buckets.delinquent_count} delinquent accounts`} />
      </div>

      {/* A/R aging buckets */}
      <Section title="A/R Aging (by outstanding amount)">
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
          <tr className="bg-rose-50"><td className="px-3 py-2 text-rose-800 font-semibold">Delinquent (legally overdue)</td><td className="px-3 py-2 text-right tabular-nums font-semibold text-rose-800">{facts.ar_buckets.delinquent_count}</td></tr>
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
                <th className="px-3 py-2 font-medium text-right">Delinquent</th>
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
                  <td className="px-3 py-2 text-right tabular-nums text-rose-700">{r.delinquent_balance > 0 ? fmt(r.delinquent_balance) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

export const FinanceDashboard: WidgetDefinition<FinanceDashboardConfig, FinanceData> = {
  id: 'finance_dashboard',
  display_name: 'Financial Reports',
  description: 'Top-line revenue, tuition by program, discounts, aid, and recipient lists.',
  category: 'billing',
  default_config: financeDashboardDefaults,
  config_schema: financeDashboardSchema,
  default_size: { w: 12, h: 12 },
  Component,
  dataFetcher: fetcher,
};
