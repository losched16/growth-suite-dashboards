// Rich Family Hub. Mirrors bespoke desert-garden-admin /families page:
// stat cards, search + filters, sortable table, pagination, inline
// accordion expansion (DG-style) for per-family detail. Filter / sort /
// pagination remain URL-state-driven (no client JS); the accordion
// expansion is handled in AccordionTable as a tiny client component
// that owns just the "which row is open" state.

import { RefreshCw } from 'lucide-react';
import type { WidgetDefinition, SchoolContext, WidgetSearchParams } from '@/lib/widgets/types';
import {
  AVAILABLE_FILTERS,
  familyHubDefaults,
  familyHubSchema,
  type FamilyHubConfig,
  type FilterKey,
} from './config';
import { fetcher, type FamilyHubData } from './fetcher';
import { DownloadCsvButton } from '@/components/DownloadCsvButton';
import { AccordionTable } from './AccordionTable';
import { PreserveEmbedParams, clearHref } from '@/lib/widgets/components/_shared/PreserveEmbedParams';
import { AutoSubmitForm } from '@/lib/widgets/components/_shared/AutoSubmitForm';
import { crmAppBase } from '@/lib/ghl/contact-url';

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
      <div className="text-2xl font-semibold" style={{ color }}>{value}</div>
      <div className="mt-0.5 text-[11px] uppercase tracking-wide text-gray-500">{label}</div>
    </div>
  );
}

function FilterRow({
  filterKeys,
  options,
  current,
}: {
  filterKeys: FilterKey[];
  options: FamilyHubData['options'];
  current: WidgetSearchParams;
}) {
  const optionsByKey: Record<FilterKey, string[]> = {
    family_status: options.family_statuses,
    enrollment_status: options.enrollment_statuses,
    program: options.programs,
    payment_plan: options.payment_plans,
    homeroom: options.homerooms,
    has_allergy: ['yes', 'no'],
  };
  const isFiltered = ['q', 'family_status', 'enrollment_status', 'program', 'payment_plan', 'homeroom', 'has_allergy']
    .some((k) => current[k] && current[k].length > 0);

  return (
    <AutoSubmitForm className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-white p-3">
      <input
        type="search"
        name="q"
        defaultValue={current.q ?? ''}
        placeholder="Search parent or student name, email…"
        className="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm placeholder:text-gray-400 focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-200"
      />
      {filterKeys.map((k) => {
        const meta = AVAILABLE_FILTERS.find((f) => f.key === k);
        if (!meta) return null;
        const opts = optionsByKey[k];
        return (
          <label key={k} className="text-xs text-gray-600">
            {meta.label}:{' '}
            <select
              name={k}
              defaultValue={current[k] ?? ''}
              className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm focus:border-emerald-600 focus:outline-none"
            >
              <option value="">all</option>
              {opts.map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          </label>
        );
      })}
      {/* Preserve sort + per_page in subsequent submissions */}
      {current.sort ? <input type="hidden" name="sort" value={current.sort} /> : null}
      {current.dir ? <input type="hidden" name="dir" value={current.dir} /> : null}
      {current.per_page ? <input type="hidden" name="per_page" value={current.per_page} /> : null}
      {/* Preserve ambient embed/chrome state across the GET submit. */}
      <PreserveEmbedParams current={current} />
      {/* Submit button kept as a no-JS fallback; AutoSubmitForm fires on
          change/input so operators never actually need to click it. */}
      <noscript>
        <button
          type="submit"
          className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800"
        >
          Apply
        </button>
      </noscript>
      {isFiltered ? <a href={clearHref(current)} className="text-xs text-gray-500 hover:underline">clear</a> : null}
    </AutoSubmitForm>
  );
}

function Pagination({
  page,
  pageCount,
  perPage,
  current,
  totalRows,
}: {
  page: number;
  pageCount: number;
  perPage: number;
  current: WidgetSearchParams;
  totalRows: number;
}) {
  const start = totalRows === 0 ? 0 : (page - 1) * perPage + 1;
  const end = Math.min(page * perPage, totalRows);

  function urlFor(targetPage: number, targetPerPage: number = perPage): string {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(current)) {
      if (v && k !== 'page' && k !== 'per_page') p.set(k, v);
    }
    p.set('page', String(targetPage));
    p.set('per_page', String(targetPerPage));
    return `?${p.toString()}`;
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white p-3 text-xs text-gray-600">
      <div>Showing {start}-{end} of {totalRows}</div>
      <div className="flex items-center gap-1">
        <a href={urlFor(1)} className={`rounded border border-gray-300 px-2 py-1 ${page <= 1 ? 'opacity-30 pointer-events-none' : 'hover:bg-gray-50'}`}>« First</a>
        <a href={urlFor(Math.max(1, page - 1))} className={`rounded border border-gray-300 px-2 py-1 ${page <= 1 ? 'opacity-30 pointer-events-none' : 'hover:bg-gray-50'}`}>‹ Prev</a>
        <span className="px-2">Page {page} of {pageCount}</span>
        <a href={urlFor(Math.min(pageCount, page + 1))} className={`rounded border border-gray-300 px-2 py-1 ${page >= pageCount ? 'opacity-30 pointer-events-none' : 'hover:bg-gray-50'}`}>Next ›</a>
        <a href={urlFor(pageCount)} className={`rounded border border-gray-300 px-2 py-1 ${page >= pageCount ? 'opacity-30 pointer-events-none' : 'hover:bg-gray-50'}`}>Last »</a>
      </div>
      <div className="flex items-center gap-1">
        Per page:
        {[25, 50, 100, 250].map((n) => (
          <a
            key={n}
            href={urlFor(1, n)}
            className={`rounded border border-gray-300 px-1.5 py-0.5 ${perPage === n ? 'bg-gray-900 text-white' : 'hover:bg-gray-50'}`}
          >
            {n}
          </a>
        ))}
      </div>
    </div>
  );
}

function Component({
  school,
  config,
  data,
  searchParams,
}: {
  school: SchoolContext;
  config: FamilyHubConfig;
  data: FamilyHubData;
  searchParams?: WidgetSearchParams;
}) {
  const showStats = config.show_stat_cards !== false;
  const filters = config.shown_filters ?? familyHubDefaults.shown_filters;
  const columns = config.shown_columns ?? familyHubDefaults.shown_columns;
  // drilldown_dashboard_slug is preserved in config for backwards compat,
  // but the accordion replaces drilldown navigation — clicking a row now
  // expands inline rather than navigating to a per-family page.
  const sp = searchParams ?? {};
  const isFiltered = data.filtered.length !== data.total_families;

  // Export URL preserves the current filter state.
  const exportParams = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (v) exportParams.set(k, v);
  }
  const exportHref = `/api/export/family-hub/${school.locationId}${exportParams.toString() ? `?${exportParams}` : ''}`;

  // Preserve the iframe URL so the sync POST lands back here with
  // the success / error flash. The URL we land on is captured from the
  // current request (browser-visible path), reconstructed from the
  // school's locationId + the family-hub embed slug.
  const syncReturnTo = `/school/${school.locationId}/family-hub`;
  // Inline flash for the sync action's redirect. Read from URL state
  // so the widget surfaces success/error WITHOUT relying on the host
  // dashboard page to render its own flash banner.
  const flashMsg = typeof sp.msg === 'string' ? sp.msg : null;
  const flashErr = typeof sp.err === 'string' ? sp.err : null;

  return (
    <div className="space-y-3">
      {flashMsg ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {flashMsg}
        </div>
      ) : null}
      {flashErr ? (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {flashErr}
        </div>
      ) : null}
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-emerald-700">Families</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            {data.stats.families} {isFiltered ? `(filtered from ${data.total_families})` : ''} ·{' '}
            {data.stats.students} students · {data.stats.enrolled} enrolled · {data.stats.accepted} accepted · {data.stats.pending} pending
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* GHL → dashboard manual sync. Posts to a school-session
              endpoint that runs runGhlSync(schoolId) and bounces back
              here with a success / error flash. Fixes the lag between
              an operator editing a contact in GHL and the change
              appearing in the Family Hub (without it the change waits
              for the daily cron). */}
          <form action="/api/school/sync-from-ghl" method="POST">
            <input type="hidden" name="return_to" value={syncReturnTo} />
            <button
              type="submit"
              title="Pull the latest contact data from GHL into the Family Hub. Takes 10-60 seconds."
              className="inline-flex items-center gap-1.5 rounded-md border border-emerald-300 bg-white px-2.5 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Sync from GHL
            </button>
          </form>
          <DownloadCsvButton href={exportHref} label={isFiltered ? 'Download filtered CSV' : 'Download CSV'} />
        </div>
      </div>

      {showStats ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <StatCard label="Families" value={data.stats.families} color="#111827" />
          <StatCard label="Students" value={data.stats.students} color="#111827" />
          <StatCard label="Enrolled" value={data.stats.enrolled} color="#047857" />
          <StatCard label="Accepted" value={data.stats.accepted} color="#1d4ed8" />
          <StatCard label="Pending" value={data.stats.pending} color="#d97706" />
        </div>
      ) : null}

      <FilterRow filterKeys={filters} options={data.options} current={sp} />
      <AccordionTable
        rows={data.page_rows}
        columns={columns}
        locationId={school.locationId}
        current={sp}
        crmAppBase={crmAppBase()}
      />
      <Pagination
        page={data.page}
        pageCount={data.page_count}
        perPage={data.per_page}
        current={sp}
        totalRows={data.filtered.length}
      />
    </div>
  );
}

export const FamilyHubTable: WidgetDefinition<FamilyHubConfig, FamilyHubData> = {
  id: 'family_hub_table',
  display_name: 'Family Hub (rich)',
  description: 'Stat cards, searchable + filterable + sortable family table with pagination.',
  category: 'family',
  default_config: familyHubDefaults,
  config_schema: familyHubSchema,
  default_size: { w: 12, h: 12 },
  Component,
  dataFetcher: fetcher,
  searchParamsAffectFetch: true,
};
