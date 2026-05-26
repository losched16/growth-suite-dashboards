// Rich Student Roster widget. List view, Grid view, Allergies view.
// All filters live in the URL.

import Link from 'next/link';
import { LayoutGrid, List as ListIcon, AlertTriangle } from 'lucide-react';
import { DocumentsCell } from './DocumentsCell';
import { PrintButton } from '@/lib/widgets/components/_shared/PrintButton';
import { StudentTableWithAccordion } from './StudentTableWithAccordion';
import type { WidgetDefinition, SchoolContext, WidgetSearchParams } from '@/lib/widgets/types';
import {
  AVAILABLE_FILTERS,
  AVAILABLE_COLUMNS,
  studentRosterDefaults,
  studentRosterSchema,
  type StudentRosterConfig,
  type FilterKey,
  type ColumnKey,
} from './config';
import { fetcher, type StudentRosterData, type RosterStudent } from './fetcher';
import { PreserveEmbedParams, clearHref } from '@/lib/widgets/components/_shared/PreserveEmbedParams';
import { AutoSubmitForm } from '@/lib/widgets/components/_shared/AutoSubmitForm';

function ageFrom(dob: string | null): string {
  if (!dob) return '—';
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return '—';
  const now = new Date();
  let yrs = now.getFullYear() - d.getFullYear();
  let mos = now.getMonth() - d.getMonth();
  if (now.getDate() < d.getDate()) mos--;
  if (mos < 0) { yrs--; mos += 12; }
  if (yrs >= 1) return `${yrs}y ${Math.max(0, mos)}m`;
  return `${Math.max(0, mos)}m`;
}

function FilterRow({
  filterKeys,
  options,
  current,
  view,
}: {
  filterKeys: FilterKey[];
  options: StudentRosterData['options'];
  current: WidgetSearchParams;
  view: string;
}) {
  const selectOpts: Record<string, string[]> = {
    program: options.programs,
    homeroom: options.homerooms,
    schedule: options.schedules,
    lead_teacher: options.teachers,
    gender: options.genders,
    lunch: options.lunches,
    attendance_status: options.attendance_statuses,
  };
  const isFiltered = ['q', 'program', 'homeroom', 'schedule', 'lead_teacher', 'gender',
                      'allergies_only', 'iep_504_only', 'lunch', 'attendance_status',
                      'lunch_only', 'curbside_only']
    .some((k) => current[k] && current[k].length > 0);

  return (
    <AutoSubmitForm className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-white p-3">
      <input
        type="search"
        name="q"
        defaultValue={current.q ?? ''}
        placeholder="Search student or parent name…"
        className="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm placeholder:text-gray-400 focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-200"
      />
      {filterKeys.map((k) => {
        const meta = AVAILABLE_FILTERS.find((f) => f.key === k);
        if (!meta) return null;
        if (meta.type === 'checkbox') {
          return (
            <label key={k} className="text-xs text-gray-600 flex items-center gap-1">
              <input
                type="checkbox"
                name={k}
                value="1"
                defaultChecked={current[k] === '1' || current[k] === 'true'}
              />
              {meta.label}
            </label>
          );
        }
        return (
          <label key={k} className="text-xs text-gray-600">
            {meta.label}:{' '}
            <select
              name={k}
              defaultValue={current[k] ?? ''}
              className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm focus:border-emerald-600 focus:outline-none"
            >
              <option value="">all</option>
              {selectOpts[k]?.map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          </label>
        );
      })}
      <input type="hidden" name="view" value={view} />
      {current.per_page ? <input type="hidden" name="per_page" value={current.per_page} /> : null}
      <PreserveEmbedParams current={current} />
      <noscript>
        <button
          type="submit"
          className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800"
        >
          Apply
        </button>
      </noscript>
      {isFiltered ? <a href={clearHref(current, { view })} className="text-xs text-gray-500 hover:underline">clear</a> : null}
    </AutoSubmitForm>
  );
}

function ViewToggle({ view, current }: { view: string; current: WidgetSearchParams }) {
  function urlFor(v: string): string {
    const p = new URLSearchParams();
    for (const [k, val] of Object.entries(current)) if (val && k !== 'view') p.set(k, val);
    p.set('view', v);
    return `?${p.toString()}`;
  }
  return (
    <div className="inline-flex rounded-md border border-gray-300 bg-white text-xs">
      <a href={urlFor('list')} className={`px-2 py-1 ${view === 'list' ? 'bg-gray-900 text-white' : 'hover:bg-gray-50'}`}>
        <ListIcon className="inline h-3 w-3 mr-1" />List
      </a>
      <a href={urlFor('grid')} className={`px-2 py-1 border-l border-gray-300 ${view === 'grid' ? 'bg-gray-900 text-white' : 'hover:bg-gray-50'}`}>
        <LayoutGrid className="inline h-3 w-3 mr-1" />Grid
      </a>
      <a href={urlFor('allergies')} className={`px-2 py-1 border-l border-gray-300 ${view === 'allergies' ? 'bg-gray-900 text-white' : 'hover:bg-gray-50'}`}>
        <AlertTriangle className="inline h-3 w-3 mr-1" />Allergies
      </a>
    </div>
  );
}

function StudentTable({
  rows, columns, drilldownDashboard, locationId,
}: {
  rows: RosterStudent[]; columns: ColumnKey[]; drilldownDashboard: string; locationId: string;
}) {
  if (rows.length === 0) {
    return <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-500">No students match.</div>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table className="w-full text-sm">
        <thead className="border-b border-gray-100 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
          <tr>{columns.map((c) => <th key={c} className="px-3 py-2 font-medium">{AVAILABLE_COLUMNS.find((x) => x.key === c)?.label ?? c}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((s) => (
            <tr key={s.student_id} className="hover:bg-gray-50">
              {columns.map((c) => <td key={c} className="px-3 py-2 align-top">{renderCell(s, c, drilldownDashboard, locationId)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Render an allergy cell that's smart about three states:
//   - Has real prose ("Eggs, milk and Almonds") — show in red, full text
//   - Legacy "Yes" flag with no detail — show in amber "(no detail on file)"
//   - No allergy or "No"/"None" — show em-dash
function renderAllergyCell(s: RosterStudent): React.ReactNode {
  if (s.allergy) {
    return <span className="text-rose-700 text-xs whitespace-pre-wrap">{s.allergy}</span>;
  }
  if (s.has_allergy) {
    // Flag is on (legacy "Yes") but no descriptive text in any source.
    return <span className="text-amber-700 text-xs italic" title="A flag was set in GHL but no descriptive allergy text is on file. Ask the parent to fill out the OTC Medication or Emergency form.">flagged · no detail</span>;
  }
  return <span className="text-gray-400">—</span>;
}

function renderCell(s: RosterStudent, col: ColumnKey, drilldownDashboard: string, locationId: string): React.ReactNode {
  switch (col) {
    case 'student':
      return (
        <span className="font-medium text-gray-900">
          {s.preferred_name ? `${s.preferred_name} (${s.first_name})` : s.first_name} {s.last_name}
          {s.has_allergy ? <AlertTriangle className="ml-1 inline h-3 w-3 text-rose-600" /> : null}
        </span>
      );
    case 'gender_age': return <span className="text-gray-700">{(s.gender ?? '—')} · {ageFrom(s.date_of_birth)}</span>;
    case 'program': return <span className="text-gray-700">{s.program ?? s.classroom_name ?? '—'}</span>;
    case 'homeroom': return <span className="text-gray-700">{s.homeroom ?? s.classroom_name ?? '—'}</span>;
    case 'lead_teacher': return <span className="text-gray-700">{s.lead_teacher_name ?? '—'}</span>;
    case 'schedule': return <span className="text-gray-700">{s.schedule ?? '—'}</span>;
    case 'status':
      return s.status ? (
        <span className="inline-block rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-800">
          {s.status.replace(/_/g, ' ')}
        </span>
      ) : <span className="text-gray-400">—</span>;
    case 'allergy': return renderAllergyCell(s);
    case 'special_instructions': return s.special_instructions
      ? <span className="text-slate-800 text-xs whitespace-pre-wrap">{s.special_instructions}</span>
      : <span className="text-gray-400">—</span>;
    case 'iep_504': {
      const tags = [];
      if (s.iep && s.iep.toLowerCase() !== 'no') tags.push('IEP');
      if (s.five04_plan && s.five04_plan.toLowerCase() !== 'no') tags.push('504');
      return tags.length > 0
        ? <span className="inline-block rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-violet-800">{tags.join('/')}</span>
        : <span className="text-gray-400">—</span>;
    }
    case 'family':
      return (
        <Link href={`/school/${locationId}/${drilldownDashboard}/${s.family_id}`} className="text-emerald-700 hover:underline">
          {s.family_display_name ?? `${s.last_name} Family`}
        </Link>
      );
    case 'documents':
      return (
        <DocumentsCell
          studentId={s.student_id}
          studentDisplay={`${s.preferred_name || s.first_name} ${s.last_name}`}
          initialCount={s.documents_count}
        />
      );
  }
}

function GridView({ rows, locationId, drilldownDashboard }: { rows: RosterStudent[]; locationId: string; drilldownDashboard: string }) {
  if (rows.length === 0) {
    return <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-500">No students match.</div>;
  }
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {rows.map((s) => (
        <Link
          key={s.student_id}
          href={`/school/${locationId}/${drilldownDashboard}/${s.family_id}`}
          className="group block rounded-lg border border-gray-200 bg-white p-3 hover:border-emerald-400 hover:shadow-sm"
        >
          <div className="flex items-start gap-2">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-xs font-semibold text-emerald-800">
              {(s.preferred_name?.[0] ?? s.first_name[0])}{s.last_name[0]}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-gray-900 truncate">
                {s.preferred_name ?? s.first_name} {s.last_name}
              </div>
              <div className="text-[11px] text-gray-500">{s.gender ?? '—'} · {ageFrom(s.date_of_birth)}</div>
            </div>
            {s.has_allergy ? <AlertTriangle className="h-4 w-4 shrink-0 text-rose-600" /> : null}
          </div>
          <dl className="mt-2 space-y-0.5 text-[11px]">
            <Row label="Program" value={s.program ?? s.classroom_name ?? '—'} />
            <Row label="Homeroom" value={s.homeroom ?? s.classroom_name ?? '—'} />
            <Row label="Teacher" value={s.lead_teacher_name ?? '—'} />
            <Row label="Schedule" value={s.schedule ?? '—'} />
            <Row label="Status" value={s.status ? s.status.replace(/_/g, ' ') : '—'} />
          </dl>
          {(s.has_iep_or_504) ? (
            <div className="mt-2">
              <span className="inline-block rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-violet-800">
                {s.iep && s.iep.toLowerCase() !== 'no' ? 'IEP' : ''}{s.iep && s.iep.toLowerCase() !== 'no' && s.five04_plan && s.five04_plan.toLowerCase() !== 'no' ? '/' : ''}{s.five04_plan && s.five04_plan.toLowerCase() !== 'no' ? '504' : ''}
              </span>
            </div>
          ) : null}
        </Link>
      ))}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-gray-500">{label}</dt>
      <dd className="text-right text-gray-700 truncate">{value}</dd>
    </div>
  );
}

function AllergiesView({ groups }: { groups: StudentRosterData['allergies_by_homeroom'] }) {
  if (groups.length === 0) {
    return <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-500">No allergies on file in the current filter.</div>;
  }
  return (
    <div className="space-y-3 print:space-y-2">
      {groups.map((g) => (
        <section key={g.homeroom} className="rounded-lg border border-gray-200 bg-white">
          <div className="flex items-center justify-between border-b border-gray-100 bg-rose-50 px-4 py-2">
            <h3 className="text-sm font-semibold text-rose-900">{g.homeroom}</h3>
            <span className="text-xs text-rose-700">{g.students.length} student{g.students.length === 1 ? '' : 's'}</span>
          </div>
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2 font-medium w-[20%]">Student</th>
                <th className="px-3 py-2 font-medium w-[30%]">Allergy / dietary</th>
                <th className="px-3 py-2 font-medium w-[40%]">Special instructions</th>
                <th className="px-3 py-2 font-medium">Other flags</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {g.students.map((s) => (
                <tr key={s.student_id} className="break-inside-avoid align-top">
                  <td className="px-3 py-2 font-medium text-gray-900">
                    {s.preferred_name ?? s.first_name} {s.last_name}
                  </td>
                  <td className="px-3 py-2">
                    {s.allergy
                      ? <span className="text-rose-700 whitespace-pre-wrap">{s.allergy}</span>
                      : s.has_allergy
                        ? <span className="text-amber-700 italic text-xs">flagged · no detail</span>
                        : <span className="text-gray-400">—</span>}
                  </td>
                  <td className="px-3 py-2 text-gray-800 text-xs whitespace-pre-wrap">
                    {s.special_instructions ?? <span className="text-gray-400">—</span>}
                  </td>
                  <td className="px-3 py-2 text-gray-700 text-xs">{s.has_iep_or_504 ? 'IEP/504' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
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
  config: StudentRosterConfig;
  data: StudentRosterData;
  searchParams?: WidgetSearchParams;
}) {
  const sp = searchParams ?? {};
  const enabledViews = config.enable_views ?? ['list', 'grid', 'allergies'];
  let view = (sp.view ?? enabledViews[0]) as 'list' | 'grid' | 'allergies';
  if (!enabledViews.includes(view)) view = enabledViews[0];

  const filters = config.shown_filters ?? studentRosterDefaults.shown_filters;
  const columns = config.shown_columns ?? studentRosterDefaults.shown_columns;
  const drilldown = config.drilldown_dashboard_slug ?? 'family-hub';

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-semibold text-emerald-700">Student Roster</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            {data.filtered.length} student{data.filtered.length === 1 ? '' : 's'}
            {data.filtered.length !== data.total_students ? ` (filtered from ${data.total_students})` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2 print:hidden">
          <ViewToggle view={view} current={sp} />
          <PrintButton
            label={view === 'allergies' ? 'Print allergies' : view === 'grid' ? 'Print grid' : 'Print roster'}
            title="Print the current view (list / grid / allergies)"
          />
        </div>
      </div>

      <div className="print:hidden">
        <FilterRow filterKeys={filters} options={data.options} current={sp} view={view} />
      </div>

      {view === 'list' ? (
        <StudentTableWithAccordion
          rows={data.page_rows}
          columns={columns}
          locationId={school.locationId}
          documentsAudience={config.documents_audience ?? 'all'}
        />
      ) : view === 'grid' ? (
        <GridView rows={data.page_rows} locationId={school.locationId} drilldownDashboard={drilldown} />
      ) : (
        <AllergiesView groups={data.allergies_by_homeroom} />
      )}

      {view !== 'allergies' && data.page_count > 1 ? (
        <div className="flex items-center justify-between text-xs text-gray-500">
          <span>Showing {(data.page - 1) * data.per_page + 1}-{Math.min(data.page * data.per_page, data.filtered.length)} of {data.filtered.length}</span>
          <PageNav page={data.page} pageCount={data.page_count} current={sp} />
        </div>
      ) : null}
    </div>
  );
}

function PageNav({ page, pageCount, current }: { page: number; pageCount: number; current: WidgetSearchParams }) {
  function urlFor(p: number): string {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(current)) if (v && k !== 'page') params.set(k, v);
    params.set('page', String(p));
    return `?${params.toString()}`;
  }
  return (
    <div className="flex items-center gap-1">
      <a href={urlFor(Math.max(1, page - 1))} className={`rounded border border-gray-300 px-2 py-1 ${page <= 1 ? 'opacity-30 pointer-events-none' : 'hover:bg-gray-50'}`}>‹ Prev</a>
      <span className="px-2">Page {page} of {pageCount}</span>
      <a href={urlFor(Math.min(pageCount, page + 1))} className={`rounded border border-gray-300 px-2 py-1 ${page >= pageCount ? 'opacity-30 pointer-events-none' : 'hover:bg-gray-50'}`}>Next ›</a>
    </div>
  );
}

export const StudentRosterRich: WidgetDefinition<StudentRosterConfig, StudentRosterData> = {
  id: 'student_roster_rich',
  display_name: 'Student Roster (rich)',
  description: 'List / Grid / Allergies view with filters, search, and per-school configurable columns.',
  category: 'student',
  default_config: studentRosterDefaults,
  config_schema: studentRosterSchema,
  default_size: { w: 12, h: 12 },
  Component,
  dataFetcher: fetcher,
  searchParamsAffectFetch: true,
};
