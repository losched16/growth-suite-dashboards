// PaymentsOverview — operator-facing dashboard widget showing the daily
// "did money come in / did anything break" view.

import { CreditCard, AlertTriangle, CheckCircle2, Banknote } from 'lucide-react';
import type { WidgetDefinition } from '@/lib/widgets/types';
import {
  paymentsOverviewDefaults,
  paymentsOverviewSchema,
  type PaymentsOverviewConfig,
} from './config';
import { fetcher, type PaymentsOverviewData } from './fetcher';

function fmtCents(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtDateTime(s: string): string {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function PaymentsOverviewComponent({ data }: { data: PaymentsOverviewData }) {
  const autopayPct = data.total_families_with_open_invoice > 0
    ? Math.round((data.autopay_enrolled_families / data.total_families_with_open_invoice) * 100)
    : 0;

  return (
    <div className="space-y-4">
      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KPI
          icon={<Banknote className="h-4 w-4" />}
          label="Collected MTD"
          value={fmtCents(data.mtd_collected_cents)}
          sub={`YTD: ${fmtCents(data.ytd_collected_cents)}`}
          tone="emerald"
        />
        <KPI
          icon={<CreditCard className="h-4 w-4" />}
          label="Open invoices"
          value={String(data.open_invoice_count)}
          sub={fmtCents(data.open_invoice_total_cents) + ' outstanding'}
          tone="neutral"
        />
        <KPI
          icon={<AlertTriangle className="h-4 w-4" />}
          label="Past due"
          value={String(data.past_due_count)}
          sub={fmtCents(data.past_due_total_cents) + ' overdue'}
          tone={data.past_due_count > 0 ? 'amber' : 'neutral'}
        />
        <KPI
          icon={<CheckCircle2 className="h-4 w-4" />}
          label="Autopay enrolled"
          value={`${autopayPct}%`}
          sub={`${data.autopay_enrolled_families} of ${data.total_families_with_open_invoice} families`}
          tone={autopayPct >= 60 ? 'emerald' : 'neutral'}
        />
      </div>

      {/* Failures section */}
      <div className="rounded-lg border border-gray-200 bg-white">
        <div className="border-b border-gray-100 px-4 py-2 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          <h3 className="text-sm font-semibold text-gray-900">Recent failed payments</h3>
          <span className="text-xs text-gray-500">({data.recent_failures.length})</span>
        </div>
        {data.recent_failures.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-gray-500 italic">
            No payment failures in the window. Nice.
          </div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {data.recent_failures.map((f) => (
              <li key={f.payment_id} className="px-4 py-2 flex items-center justify-between gap-3 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900 truncate">{f.family_label}</span>
                    <span className="text-[10px] font-mono text-gray-500">{f.invoice_number}</span>
                  </div>
                  {f.failure_message ? (
                    <div className="text-xs text-amber-700 truncate" title={f.failure_message}>
                      {f.failure_message}
                    </div>
                  ) : null}
                </div>
                <div className="text-right whitespace-nowrap">
                  <div className="font-mono text-sm text-gray-900">{fmtCents(f.amount_cents)}</div>
                  <div className="text-[10px] text-gray-500">{fmtDateTime(f.failed_at)}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Recent payments section */}
      <div className="rounded-lg border border-gray-200 bg-white">
        <div className="border-b border-gray-100 px-4 py-2 flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
          <h3 className="text-sm font-semibold text-gray-900">Recent payments</h3>
          <span className="text-xs text-gray-500">({data.recent_succeeded.length})</span>
        </div>
        {data.recent_succeeded.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-gray-500 italic">
            No payments yet. Once parents start paying, they&rsquo;ll show here.
          </div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {data.recent_succeeded.map((p) => (
              <li key={p.payment_id} className="px-4 py-2 flex items-center justify-between gap-3 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900 truncate">{p.family_label}</span>
                    <span className="text-[10px] font-mono text-gray-500">{p.invoice_number}</span>
                    {p.method_type ? (
                      <span className="text-[10px] rounded bg-gray-100 px-1.5 py-0.5 text-gray-600 uppercase">
                        {p.method_type === 'us_bank_account' ? 'ACH' : p.method_type}
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="text-right whitespace-nowrap">
                  <div className="font-mono text-sm text-emerald-700">{fmtCents(p.amount_cents)}</div>
                  <div className="text-[10px] text-gray-500">{fmtDateTime(p.succeeded_at)}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function KPI({
  icon, label, value, sub, tone,
}: {
  icon: React.ReactNode; label: string; value: string; sub: string;
  tone: 'emerald' | 'amber' | 'neutral';
}) {
  const toneClass = {
    emerald: 'border-emerald-200 bg-emerald-50',
    amber: 'border-amber-200 bg-amber-50',
    neutral: 'border-gray-200 bg-white',
  }[tone];
  const toneIcon = {
    emerald: 'text-emerald-700',
    amber: 'text-amber-700',
    neutral: 'text-gray-600',
  }[tone];
  return (
    <div className={`rounded-lg border ${toneClass} p-3`}>
      <div className={`flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide ${toneIcon}`}>
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-1 text-xl font-semibold text-gray-900 tabular-nums">{value}</div>
      <div className="text-[11px] text-gray-500 tabular-nums">{sub}</div>
    </div>
  );
}

export const PaymentsOverview: WidgetDefinition<PaymentsOverviewConfig, PaymentsOverviewData> = {
  id: 'payments_overview',
  display_name: 'Payments Overview',
  description: 'Daily payments dashboard: collections, outstanding invoices, autopay rate, and failures.',
  category: 'billing',
  default_config: paymentsOverviewDefaults,
  config_schema: paymentsOverviewSchema,
  default_size: { w: 12, h: 8 },
  Component: PaymentsOverviewComponent,
  dataFetcher: fetcher,
};
