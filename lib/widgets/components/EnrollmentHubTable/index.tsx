// Rich Enrollment Hub widget. Mirrors the bespoke desert-garden-admin
// version (top stat cards + by-program/by-homeroom bars + searchable
// filter row + full student table) but generalized so:
//   - operator picks which filters to show per school
//   - operator picks which columns to show per school
//   - filter state lives in the URL (server-rendered, no client JS)
//   - drill-through to the family-hub detail page

import Link from 'next/link';
import type { WidgetDefinition, SchoolContext, WidgetSearchParams } from '@/lib/widgets/types';
import {
  AVAILABLE_FILTERS,
  AVAILABLE_COLUMNS,
  enrollmentHubDefaults,
  enrollmentHubSchema,
  type EnrollmentHubConfig,
  type FilterKey,
  type ColumnKey,
} from './config';
import { fetcher, type EnrollmentHubData, type StudentRow } from './fetcher';
import { PreserveEmbedParams, clearHref } from '@/lib/widgets/components/_shared/PreserveEmbedParams';
import { AutoSubmitForm } from '@/lib/widgets/components/_shared/AutoSubmitForm';
import { DownloadCsvButton } from '@/components/DownloadCsvButton';
import { ghlContactUrl } from '@/lib/ghl/contact-url';

function fmtDate(s: string | null): string {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function ageFrom(dob: string | null): string {
  if (!dob) return '—';
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return '—';
  const now = new Date();
  let yrs = now.getFullYear() - d.getFullYear();
  let mos = now.getMonth() - d.getMonth();
  const days = now.getDate() - d.getDate();
  if (days < 0) { mos--; }
  if (mos < 0) { yrs--; mos += 12; }
  if (yrs >= 1) return `${yrs} YR ${Math.max(0, mos)} MO`;
  return `${Math.max(0, mos)} MO`;
}

function statusPill(status: string | null): React.ReactNode {
  if (!status) return <span className="text-xs text-gray-400">—</span>;
  const styles: Record<string, string> = {
    enrolled: 'bg-emerald-100 text-emerald-800',
    accepted: 'bg-blue-100 text-blue-800',
    application_submitted: 'bg-amber-100 text-amber-800',
    tour_scheduled: 'bg-amber-100 text-amber-800',
    inquiry: 'bg-zinc-100 text-zinc-700',
    waitlisted: 'bg-purple-100 text-purple-800',
    withdrawn: 'bg-rose-100 text-rose-800',
    declined: 'bg-rose-100 text-rose-800',
  };
  const style = styles[status] ?? 'bg-zinc-100 text-zinc-700';
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${style}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
      <div className="text-3xl font-semibold" style={{ color }}>{value}</div>
      <div className="mt-1 text-xs uppercase tracking-wide text-gray-500">{label}</div>
    </div>
  );
}

function BreakdownList({ title, rows }: { title: string; rows: EnrollmentHubData['by_program'] }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <div className="border-b border-gray-100 px-4 py-3">
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
      </div>
      <div className="divide-y divide-gray-50">
        {rows.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-gray-500">No data</div>
        ) : rows.map((r) => (
          <div key={r.label} className="px-4 py-2.5">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="font-medium text-gray-900 truncate">{r.label}</span>
              <span className="whitespace-nowrap text-gray-500">
                {r.count} · {r.enrolled} enr · {r.pending} pend · {r.accepted} acc
              </span>
            </div>
            <div className="mt-1.5 h-1.5 rounded-full bg-gray-100 overflow-hidden flex">
              {r.enrolled > 0 ? (
                <div
                  className="h-full bg-emerald-500"
                  style={{ width: `${(r.enrolled / max) * 100}%` }}
                />
              ) : null}
              {r.accepted > 0 ? (
                <div
                  className="h-full bg-amber-400"
                  style={{ width: `${(r.accepted / max) * 100}%` }}
                />
              ) : null}
              {r.pending > 0 ? (
                <div
                  className="h-full bg-blue-300"
                  style={{ width: `${(r.pending / max) * 100}%` }}
                />
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FilterRow({
  filterKeys,
  options,
  current,
}: {
  filterKeys: FilterKey[];
  options: EnrollmentHubData['options'];
  current: WidgetSearchParams;
}) {
  const optionsByKey: Record<FilterKey, string[]> = {
    status: options.statuses,
    program: options.programs,
    homeroom: options.homerooms,
    schedule: options.schedules,
    year: options.years,
    lead_teacher: options.teachers,
    iep: ['yes', 'no'],
    '504_plan': ['yes', 'no'],
    allergy: ['yes', 'no'],
  };

  // GET form so all current params (search + filters) are submitted as
  // URL params, server re-renders. Plain HTML, no JS.
  return (
    <AutoSubmitForm className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-white p-3">
      <input
        type="search"
        name="q"
        defaultValue={current.q ?? ''}
        placeholder="Search student or parent name…"
        className="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm placeholder:text-gray-400 focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-200"
      />
      {filterKeys.map((key) => {
        const meta = AVAILABLE_FILTERS.find((f) => f.key === key);
        if (!meta) return null;
        const opts = optionsByKey[key];
        return (
          <label key={key} className="text-xs text-gray-600">
            {meta.label}:{' '}
            <select
              name={key}
              defaultValue={current[key] ?? ''}
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
      <PreserveEmbedParams current={current} />
      <noscript>
        <button
          type="submit"
          className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800"
        >
          Apply
        </button>
      </noscript>
      {(Object.values(current).some((v) => v && v.length > 0)) ? (
        <a href={clearHref(current)} className="text-xs text-gray-500 hover:underline">clear</a>
      ) : null}
    </AutoSubmitForm>
  );
}

function StudentTable({
  rows,
  columns,
  drilldownDashboard,
  locationId,
}: {
  rows: StudentRow[];
  columns: ColumnKey[];
  drilldownDashboard: string;
  locationId: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-500">
        No students match the current filters.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table className="w-full text-sm">
        <thead className="border-b border-gray-100 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
          <tr>
            {columns.map((col) => {
              const meta = AVAILABLE_COLUMNS.find((c) => c.key === col);
              return <th key={col} className="px-3 py-2 font-medium">{meta?.label ?? col}</th>;
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((s) => (
            <tr key={s.student_id} className="hover:bg-gray-50">
              {columns.map((col) => (
                <td key={col} className="px-3 py-2 align-top">
                  {renderCell(s, col, drilldownDashboard, locationId)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderCell(
  s: StudentRow,
  col: ColumnKey,
  drilldownDashboard: string,
  locationId: string,
): React.ReactNode {
  switch (col) {
    case 'student': {
      const display = s.preferred_name
        ? `${s.preferred_name} (${s.first_name})`
        : s.first_name;
      return <span className="font-medium text-gray-900">{display} {s.last_name}</span>;
    }
    case 'dob': return <span className="text-gray-700">{fmtDate(s.date_of_birth)}</span>;
    case 'age': return <span className="text-gray-700">{ageFrom(s.date_of_birth)}</span>;
    case 'status': return statusPill(s.status);
    case 'program': return <span className="text-gray-700">{s.program ?? s.classroom_name ?? '—'}</span>;
    case 'year': return <span className="text-gray-700">{s.academic_year ?? '—'}</span>;
    case 'homeroom': return <span className="text-gray-700">{s.homeroom ?? s.classroom_name ?? '—'}</span>;
    case 'lead_teacher': return <span className="text-gray-700">{s.lead_teacher_name ?? '—'}</span>;
    case 'schedule': return <span className="text-gray-700">{s.schedule ?? '—'}</span>;
    case 'started': return <span className="text-gray-700">{fmtDate(s.enrolled_at)}</span>;
    case 'family': {
      // Prefer a deep-link into the GHL/Growth Suite contact record
      // (operators want the CRM, not the internal family-hub page).
      // Fall back to the in-dashboard family-hub page only if we
      // somehow don't have a GHL contact id on file.
      const label = s.family_display_name ?? `${s.last_name} Family`;
      if (s.primary_parent_ghl_contact_id) {
        return (
          <a
            href={ghlContactUrl(locationId, s.primary_parent_ghl_contact_id)}
            target="_top"
            rel="noreferrer"
            className="text-emerald-700 hover:underline"
            title="Open contact record in Growth Suite"
          >
            {label} ↗
          </a>
        );
      }
      return (
        <Link
          href={`/school/${locationId}/${drilldownDashboard}/${s.family_id}`}
          className="text-emerald-700 hover:underline"
        >
          {label} ↗
        </Link>
      );
    }
    case 'iep': return s.iep && s.iep.toLowerCase() !== 'no' ? <span className="text-amber-700">{s.iep}</span> : <span className="text-gray-400">—</span>;
    case '504_plan': return s.five04_plan && s.five04_plan.toLowerCase() !== 'no' ? <span className="text-amber-700">{s.five04_plan}</span> : <span className="text-gray-400">—</span>;
    case 'allergy': return s.allergy && s.allergy.toLowerCase() !== 'no' && s.allergy.toLowerCase() !== 'none' ? <span className="text-rose-700">{s.allergy}</span> : <span className="text-gray-400">—</span>;
    default: return '—';
  }
}

function Component({
  school,
  config,
  data,
  searchParams,
}: {
  school: SchoolContext;
  config: EnrollmentHubConfig;
  data: EnrollmentHubData;
  searchParams?: WidgetSearchParams;
}) {
  const showStats = config.show_stat_cards !== false;
  const showBreakdowns = config.show_breakdowns !== false;
  const filters = config.shown_filters ?? enrollmentHubDefaults.shown_filters;
  const columns = config.shown_columns ?? enrollmentHubDefaults.shown_columns;
  const drilldown = config.drilldown_dashboard_slug ?? 'family-hub';
  const sp = searchParams ?? {};
  const isFiltered = Object.values(sp).some((v) => v && v.length > 0);

  // Build export URL preserving the current filter set
  const exportParams = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (v) exportParams.set(k, v);
  }
  const exportHref = `/api/export/enrollment-hub/${school.locationId}${exportParams.toString() ? `?${exportParams}` : ''}`;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-emerald-700">Enrollment</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            {data.stats.total} student{data.stats.total === 1 ? '' : 's'}
            {isFiltered ? ` (filtered from ${data.all_students.length})` : ''}
            {data.by_program.length > 0 ? ` across ${data.by_program.length} program${data.by_program.length === 1 ? '' : 's'}` : ''}
          </p>
        </div>
        <DownloadCsvButton href={exportHref} label={isFiltered ? 'Download filtered CSV' : 'Download CSV'} />
      </div>

      {/* Stat cards */}
      {showStats ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Enrolled" value={data.stats.enrolled} color="#047857" />
          <StatCard label="Pending" value={data.stats.pending} color="#d97706" />
          <StatCard label="Accepted" value={data.stats.accepted} color="#1d4ed8" />
          <StatCard label="Total students" value={data.stats.total} color="#111827" />
        </div>
      ) : null}

      {/* Breakdowns */}
      {showBreakdowns ? (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <BreakdownList title="By program" rows={data.by_program} />
          <BreakdownList title="By grade level" rows={data.by_homeroom} />
        </div>
      ) : null}

      {/* Filters + table */}
      <FilterRow filterKeys={filters} options={data.options} current={sp} />
      <StudentTable rows={data.filtered} columns={columns} drilldownDashboard={drilldown} locationId={school.locationId} />
    </div>
  );
}

export const EnrollmentHubTable: WidgetDefinition<EnrollmentHubConfig, EnrollmentHubData> = {
  id: 'enrollment_hub_table',
  display_name: 'Enrollment Hub (rich)',
  description: 'Top-line stats, by-program / by-homeroom breakdowns, searchable + filterable student table.',
  category: 'enrollment',
  default_config: enrollmentHubDefaults,
  config_schema: enrollmentHubSchema,
  default_size: { w: 12, h: 12 },
  Component,
  dataFetcher: fetcher,
  searchParamsAffectFetch: true,
};
