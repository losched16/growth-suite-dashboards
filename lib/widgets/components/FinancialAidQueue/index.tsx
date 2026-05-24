// FinancialAidQueue widget — admin-facing inbox for parent-submitted FA
// applications. Per the TuitionBridge brief §1, the workflow this replaces
// is: parent emails docs → school manually reviews → schools mails decision.
// MVP cut: no AI extraction, no Stripe, no multi-parent splits — just the
// submission → review → decision loop, demoable to schools.

import type { WidgetDefinition, SchoolContext, WidgetSearchParams } from '@/lib/widgets/types';
import {
  financialAidQueueDefaults,
  financialAidQueueSchema,
  type FinancialAidQueueConfig,
} from './config';
import { fetcher, type FinancialAidQueueData } from './fetcher';
import { QueueTable } from './QueueTable';
import { AutoSubmitForm } from '@/lib/widgets/components/_shared/AutoSubmitForm';
import { PreserveEmbedParams, clearHref } from '@/lib/widgets/components/_shared/PreserveEmbedParams';
import { crmAppBase } from '@/lib/ghl/contact-url';

function StatCard({
  label, value, color, href,
}: {
  label: string;
  value: string;
  color?: string;
  href?: string;
}) {
  const body = (
    <>
      <div className="text-2xl font-semibold tabular-nums" style={{ color: color ?? '#111827' }}>{value}</div>
      <div className="mt-0.5 text-[11px] uppercase tracking-wide text-gray-500">{label}</div>
    </>
  );
  return href ? (
    <a href={href} className="block rounded-lg border border-gray-200 bg-white px-4 py-3 hover:border-emerald-400 hover:bg-emerald-50/30">
      {body}
    </a>
  ) : (
    <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">{body}</div>
  );
}

function fmtMoney(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function filterHref(current: WidgetSearchParams, set: Record<string, string>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(current)) {
    if (v && !['status', 'year', 'q', 'page'].includes(k)) p.set(k, v);
  }
  for (const [k, v] of Object.entries(set)) if (v) p.set(k, v);
  return `?${p.toString()}#queue`;
}

function Component({
  school,
  config,
  data,
  searchParams,
}: {
  school: SchoolContext;
  config: FinancialAidQueueConfig;
  data: FinancialAidQueueData;
  searchParams?: WidgetSearchParams;
}) {
  const sp = searchParams ?? {};
  const isFiltered = !!(sp.q || sp.status || sp.year);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-emerald-700">Financial Aid Applications</h2>
        <p className="mt-0.5 text-xs text-gray-500">
          Review submitted applications, set recommended awards, and decide.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StatCard
          label="Submitted"
          value={String(data.stats.submitted)}
          color="#d97706"
          href={filterHref(sp, { status: 'submitted' })}
        />
        <StatCard
          label="In review"
          value={String(data.stats.reviewing)}
          color="#1d4ed8"
          href={filterHref(sp, { status: 'reviewing' })}
        />
        <StatCard
          label="Decided"
          value={String(data.stats.decided)}
          color="#047857"
          href={filterHref(sp, { status: 'decided' })}
        />
        <StatCard
          label="Total requested"
          value={fmtMoney(data.stats.total_requested)}
        />
        <StatCard
          label="Total awarded"
          value={fmtMoney(data.stats.total_recommended)}
          color="#047857"
        />
      </div>

      <AutoSubmitForm className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-white p-3">
        <input
          type="search"
          name="q"
          defaultValue={sp.q ?? ''}
          placeholder="Search family, student, parent name, or email…"
          className="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm placeholder:text-gray-400 focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-200"
        />
        <label className="text-xs text-gray-600">
          Status:{' '}
          <select name="status" defaultValue={sp.status ?? ''} className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm focus:border-emerald-600 focus:outline-none">
            <option value="">all</option>
            <option value="submitted">submitted</option>
            <option value="reviewing">reviewing</option>
            <option value="decided">decided</option>
            <option value="withdrawn">withdrawn</option>
          </select>
        </label>
        <label className="text-xs text-gray-600">
          Year:{' '}
          <select name="year" defaultValue={sp.year ?? ''} className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm focus:border-emerald-600 focus:outline-none">
            <option value="">all</option>
            {data.options.academic_years.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </label>
        <PreserveEmbedParams current={sp} />
        <noscript>
          <button type="submit" className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800">
            Apply
          </button>
        </noscript>
        {isFiltered ? <a href={clearHref(sp)} className="text-xs text-gray-500 hover:underline">clear</a> : null}
      </AutoSubmitForm>

      <div id="queue">
        <QueueTable
          rows={data.rows}
          locationId={school.locationId}
          crmAppBase={crmAppBase()}
          schoolId={school.schoolId}
          awardFloor={config.default_recommended_award_floor}
          awardCeiling={config.default_recommended_award_ceiling}
        />
      </div>
    </div>
  );
}

export const FinancialAidQueue: WidgetDefinition<FinancialAidQueueConfig, FinancialAidQueueData> = {
  id: 'financial_aid_queue',
  display_name: 'Financial Aid Queue',
  description:
    'Review parent-submitted FA applications, set recommended awards, and finalize decisions. ' +
    'Source: parent portal /financial-aid submissions.',
  category: 'billing',
  default_config: financialAidQueueDefaults,
  config_schema: financialAidQueueSchema,
  default_size: { w: 12, h: 16 },
  Component,
  dataFetcher: fetcher,
  searchParamsAffectFetch: true,
};
