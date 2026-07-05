// PortalFormsTracker widget — family-row tracker with per-student chips
// driven by portal_form_submissions. Visual structure copied from the
// DocumentTracker so admins get a consistent look across both views.

import Link from 'next/link';
import type { WidgetDefinition, SchoolContext, WidgetSearchParams } from '@/lib/widgets/types';
import {
  portalFormsTrackerDefaults,
  portalFormsTrackerSchema,
  type PortalFormsTrackerConfig,
} from './config';
import {
  fetcher,
  type PortalFormsTrackerData,
  type FamilyRow,
  type FormDef,
  type StudentChip,
} from './fetcher';
import { PreserveEmbedParams, clearHref } from '@/lib/widgets/components/_shared/PreserveEmbedParams';
import { AutoSubmitForm } from '@/lib/widgets/components/_shared/AutoSubmitForm';
import { deriveEmbedToken } from '@/lib/auth/embed';

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

// Build the "View as parent" URL with a deterministic embed_token so
// the route can authenticate without depending on cookies. Cookies
// don't survive the new-tab open from inside the GHL iframe — they're
// set as partitioned + SameSite=None, which means they only attach in
// the original iframe context, not in a new tab opened from it. The
// embed_token is HMAC(secret, locationId), the same token the iframe
// itself uses on first load; the view-as-parent route verifies it
// against the family's school's locationId.
//
// We re-derive here rather than reading from sp.embed_token because
// the proxy strips embed_token off the URL after minting the session
// cookie, so sp doesn't carry it through.
function viewAsParentHref(familyId: string, locationId: string): string {
  const token = deriveEmbedToken(locationId);
  return `/api/school/family/${familyId}/view-as-parent?embed_token=${encodeURIComponent(token)}`;
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

function StatCard({ value, label, color, sublabel }: {
  value: number;
  label: string;
  color: string;
  sublabel?: string;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className={`text-3xl font-bold tabular-nums ${color}`}>{value}</div>
      <div className="mt-0.5 text-xs uppercase tracking-wide text-gray-500">{label}</div>
      {sublabel ? (
        <div className="mt-0.5 text-[10px] text-gray-400 tabular-nums">{sublabel}</div>
      ) : null}
    </div>
  );
}

// Numbered chip per student in the family.
function Chip({
  applies, complete, slot, title, href,
}: {
  applies: boolean;
  complete: boolean;
  slot: number;
  title: string;
  href: string | null;
}) {
  const base = 'inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[10px] font-medium';
  const cls = !applies
    ? `${base} bg-gray-50 text-gray-300`
    : complete
      ? `${base} bg-emerald-100 text-emerald-800 hover:bg-emerald-200`
      : `${base} bg-rose-100 text-rose-800`;
  const content = <span className={cls} title={title}>{slot}</span>;
  return complete && href ? <Link href={href}>{content}</Link> : content;
}

// Family-level form → single ✓ / ✗ marker instead of a slot chip.
function FamilyMark({
  complete, title, href,
}: { complete: boolean; title: string; href: string | null }) {
  const base = 'inline-flex h-6 w-6 items-center justify-center rounded-full text-sm font-bold';
  const cls = complete
    ? `${base} bg-emerald-100 text-emerald-700 hover:bg-emerald-200`
    : `${base} bg-rose-100 text-rose-700`;
  const content = <span className={cls} title={title}>{complete ? '✓' : '✗'}</span>;
  return complete && href ? <Link href={href}>{content}</Link> : content;
}

function Component({
  school, config, data, searchParams,
}: {
  school: SchoolContext;
  config: PortalFormsTrackerConfig;
  data: PortalFormsTrackerData;
  searchParams?: WidgetSearchParams;
}) {
  const sp = searchParams ?? {};
  const formFilter = sp.form ?? 'all';
  const shownForms = formFilter === 'all'
    ? data.forms
    : data.forms.filter((f) => f.id === formFilter);
  const visible = applyFiltersSort(data.rows, sp);

  const familyHref = (familyId: string) =>
    config.drilldown === 'family-hub'
      ? `/school/${school.locationId}/family-hub/${familyId}`
      : `/school/${school.locationId}/families/${familyId}/forms?chrome=none`;

  // Empty state
  if (data.forms.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-gray-300 bg-amber-50 p-6 text-center text-sm text-amber-900">
        <strong>No active parent-portal forms for this school.</strong>
        <div className="mt-1 text-xs">
          Publish at least one form via the Forms tab in Payments and it will show here.
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
            Portal Forms — {school.schoolName}
          </h2>
          <p className="mt-1 text-xs text-gray-600">
            {data.stats.total_students} students across {data.stats.enrolled_families} families
            {data.stats.pending_students
              ? ` (${data.stats.total_students - data.stats.pending_students} enrolled · ${data.stats.pending_students} pending)`
              : ''} ·{' '}
            Last loaded {new Date(data.last_loaded_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })}
          </p>
          {config.enrolled_tag || config.excluded_tag ? (
            <p className="mt-1 text-[11px] text-gray-500 flex flex-wrap items-center gap-1">
              <span>Filter:</span>
              {config.enrolled_tag ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-800">
                  has tag &ldquo;{config.enrolled_tag}&rdquo;
                </span>
              ) : null}
              {config.excluded_tag ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-rose-800">
                  no tag &ldquo;{config.excluded_tag}&rdquo;
                </span>
              ) : null}
              <span className="text-gray-400">· tags sync from GHL every 15 min</span>
            </p>
          ) : null}
        </div>
      </div>

      {/* Stat cards — primary unit is STUDENTS (a family with 2 kids
          counts as 2 here). Family-level counts surface as sub-labels
          for context. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard
          value={data.stats.total_students}
          label="Students Tracked"
          color="text-emerald-700"
          sublabel={data.stats.pending_students
            ? `${data.stats.total_students - data.stats.pending_students} enrolled · ${data.stats.pending_students} pending · ${data.stats.enrolled_families} families`
            : `${data.stats.enrolled_families} families`}
        />
        <StatCard
          value={data.stats.students_fully_complete}
          label="Fully Complete"
          color="text-emerald-600"
          sublabel={`${data.stats.families_fully_complete} families`}
        />
        <StatCard
          value={data.stats.students_in_progress}
          label="In Progress"
          color="text-amber-600"
          sublabel={`${data.stats.families_in_progress} families`}
        />
        <StatCard
          value={data.stats.students_not_started}
          label="Not Started"
          color="text-rose-600"
          sublabel={`${data.stats.families_not_started} families`}
        />
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
              <th className="px-4 py-3 font-semibold sticky left-0 bg-gray-50">Family</th>
              <th className="px-3 py-3 font-semibold">%</th>
              {shownForms.map((f) => (
                <th key={f.id} className="px-3 py-3 font-semibold whitespace-nowrap text-center align-bottom">
                  <div className="text-[11px] leading-tight">{f.display_name}</div>
                  {!f.per_student ? (
                    <div className="text-[9px] uppercase tracking-wide text-gray-400 mt-0.5">family-level</div>
                  ) : null}
                </th>
              ))}
              <th className="px-3 py-3 font-semibold whitespace-nowrap">Students</th>
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
                  <td className="px-4 py-3 align-top sticky left-0 bg-white">
                    <Link
                      href={familyHref(r.family_id)}
                      className="font-semibold text-emerald-700 hover:underline"
                    >
                      {r.family_display_name}
                    </Link>
                    {r.pending_student_count > 0 ? (
                      <span
                        className="ml-1.5 inline-flex items-center rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 align-middle"
                        title="Mid-admissions: this family has students whose enrollment status is still Pending — they aren't enrolled until their forms are done."
                      >
                        pending
                      </span>
                    ) : null}
                    <div className="text-[11px] text-gray-500">{r.primary_parent_email || '—'}</div>
                    <a
                      href={viewAsParentHref(r.family_id, school.locationId)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 inline-flex items-center gap-1 rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-800 hover:bg-blue-100"
                      title="Sign in as this family's primary parent in a new tab. Verify prefill + see what they see."
                    >
                      👤 View as parent
                    </a>
                  </td>
                  <td className={`px-3 py-3 align-top font-semibold tabular-nums ${pctColor(r.pct)}`}>
                    {r.pct}%
                  </td>
                  {shownForms.map((form) => {
                    const cells = r.cells[form.id] ?? [];
                    return (
                      <td key={form.id} className="px-3 py-3 align-top">
                        <div className="flex flex-wrap justify-center gap-1">
                          <FormCellContent
                            form={form}
                            cells={cells}
                            locationId={school.locationId}
                            familyId={r.family_id}
                          />
                        </div>
                      </td>
                    );
                  })}
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
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FormCellContent({
  form, cells, locationId, familyId,
}: {
  form: FormDef;
  cells: StudentChip[];
  locationId: string;
  familyId: string;
}) {
  const submissionHref = (sub: StudentChip): string | null =>
    sub.submission_id
      ? `/school/${locationId}/forms/${form.id}/submissions/${sub.submission_id}?chrome=none`
      : null;
  if (cells.length === 0) {
    return <span className="text-[10px] text-gray-300">—</span>;
  }
  if (!form.per_student) {
    // Single ✓ / ✗ marker for family-level forms
    const c = cells[0];
    return (
      <FamilyMark
        complete={c.complete}
        title={c.complete && c.submitted_at
          ? `Submitted ${new Date(c.submitted_at).toLocaleDateString()} · click to view`
          : 'Not submitted yet'}
        href={submissionHref(c)}
      />
    );
  }
  // Per-student chips
  void familyId;
  return (
    <>
      {cells.map((c) => (
        <Chip
          key={c.student_id}
          applies={c.applies}
          complete={c.complete}
          slot={c.slot}
          title={!c.applies
            ? `${c.display_name} — not applicable`
            : c.complete && c.submitted_at
              ? `${c.display_name} — submitted ${new Date(c.submitted_at).toLocaleDateString()} (click to view)`
              : `${c.display_name} — pending`}
          href={submissionHref(c)}
        />
      ))}
    </>
  );
}

export const PortalFormsTracker: WidgetDefinition<PortalFormsTrackerConfig, PortalFormsTrackerData> = {
  id: 'portal_forms_tracker',
  display_name: 'Portal Forms Tracker',
  description: 'Family-row grid showing per-student completion of every active parent-portal form, with stats + filters.',
  category: 'documents',
  default_config: portalFormsTrackerDefaults,
  config_schema: portalFormsTrackerSchema,
  default_size: { w: 12, h: 12 },
  Component,
  dataFetcher: fetcher,
  searchParamsAffectFetch: false,
};
