// Document Tracker widget (platform version of the Wooster-style tracker).
// Family-row layout with per-student chips in each form column. URL-state
// driven filters: search (q), status filter (status=complete|in_progress|
// not_started|all), form filter (form=<formId>|all), sort (sort=name|
// pct_desc|pct_asc). Auto-refresh interval is per-instance config.

import Link from 'next/link';
import type { WidgetDefinition, SchoolContext, WidgetSearchParams } from '@/lib/widgets/types';
import { documentTrackerDefaults, documentTrackerSchema, type DocumentTrackerConfig } from './config';
import { fetcher, type DocumentTrackerData, type FamilyRow, type FormDef } from './fetcher';
import { AutoRefresh } from './AutoRefresh';
import { DownloadCsvButton } from '@/components/DownloadCsvButton';
import { PreserveEmbedParams, clearHref } from '@/lib/widgets/components/_shared/PreserveEmbedParams';
import { AutoSubmitForm } from '@/lib/widgets/components/_shared/AutoSubmitForm';

const STATUS_FILTERS = [
  { key: 'all', label: 'All families' },
  { key: 'complete', label: 'Fully Complete' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'not_started', label: 'Not Started' },
] as const;

const SORTS = [
  { key: 'name', label: 'Name' },
  { key: 'pct_desc', label: '% complete (high→low)' },
  { key: 'pct_asc', label: '% complete (low→high)' },
] as const;

function pctColor(pct: number): string {
  if (pct === 100) return 'text-emerald-600';
  if (pct >= 50) return 'text-amber-600';
  return 'text-rose-600';
}

function applyFiltersSort(
  rows: FamilyRow[],
  sp: WidgetSearchParams,
): FamilyRow[] {
  const q = (sp.q ?? '').trim().toLowerCase();
  const status = (sp.status ?? 'all').trim();
  const sort = (sp.sort ?? 'name').trim();

  let list = rows;
  if (status !== 'all') list = list.filter((r) => r.status === status);
  if (q) {
    list = list.filter((r) => {
      const studentNames = r.enrolled_students.map((s) => s.display_name).join(' ').toLowerCase();
      return (
        r.family_display_name.toLowerCase().includes(q) ||
        r.primary_parent_name.toLowerCase().includes(q) ||
        (r.primary_parent_email ?? '').toLowerCase().includes(q) ||
        studentNames.includes(q)
      );
    });
  }
  list = [...list].sort((a, b) => {
    if (sort === 'pct_desc') return b.pct - a.pct || a.family_display_name.localeCompare(b.family_display_name);
    if (sort === 'pct_asc') return a.pct - b.pct || a.family_display_name.localeCompare(b.family_display_name);
    return a.family_display_name.localeCompare(b.family_display_name);
  });
  return list;
}

function FilterBar({
  current,
  forms,
}: {
  current: WidgetSearchParams;
  forms: FormDef[];
}) {
  return (
    <AutoSubmitForm className="grid grid-cols-1 md:grid-cols-12 gap-2">
      <input
        type="search"
        name="q"
        defaultValue={current.q ?? ''}
        placeholder="Search families, emails, students…"
        className="md:col-span-6 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm placeholder:text-gray-400 focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-200"
      />
      <select
        name="status"
        defaultValue={current.status ?? 'all'}
        className="md:col-span-2 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
      >
        {STATUS_FILTERS.map((s) => (
          <option key={s.key} value={s.key}>{s.label}</option>
        ))}
      </select>
      <select
        name="form"
        defaultValue={current.form ?? 'all'}
        className="md:col-span-2 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
      >
        <option value="all">All forms</option>
        {forms.map((f) => (
          <option key={f.id} value={f.id}>Form: {f.display_name}</option>
        ))}
      </select>
      <select
        name="sort"
        defaultValue={current.sort ?? 'name'}
        className="md:col-span-1 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
      >
        {SORTS.map((s) => (
          <option key={s.key} value={s.key}>Sort: {s.label}</option>
        ))}
      </select>
      <PreserveEmbedParams current={current} />
      <noscript>
        <button
          type="submit"
          className="md:col-span-1 rounded-md bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-800"
        >
          Apply
        </button>
      </noscript>
    </AutoSubmitForm>
  );
}

function StatCard({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className={`text-3xl font-bold tabular-nums ${color}`}>{value}</div>
      <div className="mt-0.5 text-xs uppercase tracking-wide text-gray-500">{label}</div>
    </div>
  );
}

function Chip({
  applies,
  complete,
  slot,
  title,
}: {
  applies: boolean;
  complete: boolean;
  slot: number;
  title: string;
}) {
  if (!applies) {
    return (
      <span
        title={title}
        className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-gray-50 px-1.5 text-[10px] font-medium text-gray-300"
      >
        {slot}
      </span>
    );
  }
  if (complete) {
    return (
      <span
        title={title}
        className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-emerald-100 px-1.5 text-[10px] font-medium text-emerald-800"
      >
        {slot}
      </span>
    );
  }
  return (
    <span
      title={title}
      className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-100 px-1.5 text-[10px] font-medium text-rose-800"
    >
      {slot}
    </span>
  );
}

function Component({
  school,
  config,
  data,
  searchParams,
}: {
  school: SchoolContext;
  config: DocumentTrackerConfig;
  data: DocumentTrackerData;
  searchParams?: WidgetSearchParams;
}) {
  const sp = searchParams ?? {};
  const formFilter = sp.form ?? 'all';
  const shownForms =
    formFilter === 'all' ? data.forms : data.forms.filter((f) => f.id === formFilter);
  const visible = applyFiltersSort(data.rows, sp);
  const drilldown = config.drilldown_dashboard_slug ?? 'family-hub';
  const autoRefreshMs = config.auto_refresh_ms ?? documentTrackerDefaults.auto_refresh_ms!;

  // Empty state — no forms configured at all
  if (data.forms.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-gray-300 bg-amber-50 p-6 text-center text-sm text-amber-900">
        <strong>No forms configured for this school.</strong>
        <div className="mt-1 text-xs">
          Go to /admin/&#123;school&#125; → Parent portal → Forms parents see, and add the forms you want tracked here.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold text-emerald-800">
            Document Tracker — {school.schoolName}
          </h2>
          <p className="mt-1 text-xs text-gray-600">
            {data.stats.total_students} students across {data.stats.enrolled_families} families ·{' '}
            <AutoRefresh intervalMs={autoRefreshMs} />
          </p>
        </div>
        <div className="flex items-center gap-2">
          <DownloadCsvButton href={`/api/export/document-tracker/${school.locationId}`} label="Family-level CSV" size="xs" />
          <DownloadCsvButton href={`/api/export/document-tracker/${school.locationId}?type=per_student`} label="Per-student CSV" size="xs" />
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard value={data.stats.enrolled_families} label="Enrolled Families" color="text-emerald-700" />
        <StatCard value={data.stats.fully_complete} label="Fully Complete" color="text-emerald-600" />
        <StatCard value={data.stats.in_progress} label="In Progress" color="text-amber-600" />
        <StatCard value={data.stats.not_started} label="Not Started" color="text-rose-600" />
      </div>

      {/* Filter bar */}
      <FilterBar current={sp} forms={data.forms} />

      {/* Active filters pill row */}
      {(sp.status && sp.status !== 'all') || (sp.form && sp.form !== 'all') || sp.q ? (
        <div className="flex flex-wrap items-center gap-1 text-[11px] text-gray-600">
          {sp.status && sp.status !== 'all' ? (
            <span className="rounded-full bg-gray-100 px-2 py-0.5">
              Status: {STATUS_FILTERS.find((s) => s.key === sp.status)?.label}
            </span>
          ) : null}
          {sp.form && sp.form !== 'all' ? (
            <span className="rounded-full bg-gray-100 px-2 py-0.5">
              Form: {data.forms.find((f) => f.id === sp.form)?.display_name}
            </span>
          ) : null}
          {sp.q ? (
            <span className="rounded-full bg-gray-100 px-2 py-0.5">Search: &ldquo;{sp.q}&rdquo;</span>
          ) : null}
          <a href={clearHref(sp)} className="text-emerald-700 underline hover:text-emerald-800">clear all</a>
          <span className="ml-auto tabular-nums text-gray-500">
            {visible.length} of {data.rows.length} families
          </span>
        </div>
      ) : null}

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200 text-left text-xs text-gray-600">
            <tr>
              <th className="px-4 py-3 font-semibold">Family</th>
              <th className="px-3 py-3 font-semibold">%</th>
              <th className="px-3 py-3 font-semibold whitespace-nowrap">Students</th>
              {shownForms.map((f) => (
                <th key={f.id} className="px-3 py-3 font-semibold whitespace-nowrap text-center">
                  {f.display_name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {visible.length === 0 ? (
              <tr>
                <td colSpan={3 + shownForms.length} className="px-4 py-8 text-center text-sm text-gray-500">
                  No families match the current filters.
                </td>
              </tr>
            ) : (
              visible.map((r) => (
                <tr key={r.family_id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 align-top">
                    <Link
                      href={`/school/${school.locationId}/${drilldown}/${r.family_id}`}
                      className="font-semibold text-emerald-700 hover:underline"
                    >
                      {r.family_display_name}
                    </Link>
                    <div className="text-[11px] text-gray-500">{r.primary_parent_email || '—'}</div>
                  </td>
                  <td className={`px-3 py-3 align-top font-semibold tabular-nums ${pctColor(r.pct)}`}>
                    {r.pct}%
                  </td>
                  <td className="px-3 py-3 align-top">
                    <ol className="text-xs text-gray-700 space-y-0.5">
                      {r.enrolled_students.map((s, i) => (
                        <li key={s.student_id}>
                          <span className="text-gray-400 tabular-nums">{i + 1}.</span>{' '}
                          <span className="text-gray-900">{s.display_name}</span>
                        </li>
                      ))}
                    </ol>
                  </td>
                  {shownForms.map((form) => {
                    const cells = r.cells[form.id] ?? [];
                    return (
                      <td key={form.id} className="px-3 py-3 align-top">
                        <div className="flex flex-wrap justify-center gap-1">
                          {cells.map((c) => (
                            <Chip
                              key={c.student_id}
                              applies={c.applies}
                              complete={c.complete}
                              slot={c.slot}
                              title={`${c.display_name} — ${!c.applies ? 'not applicable' : c.complete ? `complete${c.completed_value ? ` (${c.completed_value})` : ''}` : 'pending'}`}
                            />
                          ))}
                          {cells.length === 0 ? <span className="text-[10px] text-gray-300">—</span> : null}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export const DocumentTracker: WidgetDefinition<DocumentTrackerConfig, DocumentTrackerData> = {
  id: 'document_tracker',
  display_name: 'Document Tracker (rich)',
  description: 'Family-row tracker with per-student chips per form, auto-refreshing.',
  category: 'documents',
  default_config: documentTrackerDefaults,
  config_schema: documentTrackerSchema,
  default_size: { w: 12, h: 12 },
  Component,
  dataFetcher: fetcher,
  searchParamsAffectFetch: false, // filtering happens in the component on already-fetched rows
};
