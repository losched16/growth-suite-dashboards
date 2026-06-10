// AttendanceDashboard — admin's school-wide view. Live counts, classroom
// + status filters, roster table with inline drawer. CSV export. Date
// selector for historical views (read-only).

import { Download } from 'lucide-react';
import type { WidgetDefinition, SchoolContext, WidgetSearchParams } from '@/lib/widgets/types';
import {
  attendanceDashboardDefaults,
  attendanceDashboardSchema,
  type AttendanceDashboardConfig,
} from './config';
import { fetcher, type AttendanceDashboardData } from './fetcher';
import { RosterTable } from './RosterTable';
import { ReportsPanel } from './ReportsPanel';
import { AutoSubmitForm } from '@/lib/widgets/components/_shared/AutoSubmitForm';
import { PreserveEmbedParams, clearHref } from '@/lib/widgets/components/_shared/PreserveEmbedParams';

const TZ = 'America/Phoenix';

function StatCard({
  label, value, color, href,
}: {
  label: string; value: string | number; color?: string; href?: string;
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

function filterHref(current: WidgetSearchParams, set: Record<string, string>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(current)) {
    if (v && !['status', 'classroom', 'q', 'curbside'].includes(k)) p.set(k, v);
  }
  for (const [k, v] of Object.entries(set)) if (v) p.set(k, v);
  return `?${p.toString()}#roster`;
}

function Component({
  school,
  data,
  searchParams,
}: {
  school: SchoolContext;
  config: AttendanceDashboardConfig;
  data: AttendanceDashboardData;
  searchParams?: WidgetSearchParams;
}) {
  const sp = searchParams ?? {};
  const isFiltered = !!(sp.classroom || sp.status || sp.q || sp.curbside);

  // CSV export URL preserves current filters + date
  const exportParams = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (v) exportParams.set(k, v);
  if (!exportParams.has('date')) exportParams.set('date', data.date_iso);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-emerald-700">Attendance</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            {data.date_label}{data.is_today ? ' · today' : ''} · {data.stats.total} students on roster
          </p>
        </div>
        <div className="flex items-center gap-2">
          <form method="GET" className="flex items-center gap-1">
            <label className="text-xs text-gray-600">Date:</label>
            <input
              type="date"
              name="date"
              defaultValue={data.date_iso}
              className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm focus:border-emerald-600 focus:outline-none"
            />
            {sp.classroom ? <input type="hidden" name="classroom" value={sp.classroom} /> : null}
            {sp.status ? <input type="hidden" name="status" value={sp.status} /> : null}
            {sp.curbside ? <input type="hidden" name="curbside" value={sp.curbside} /> : null}
            {sp.q ? <input type="hidden" name="q" value={sp.q} /> : null}
            <PreserveEmbedParams current={sp} />
            <button type="submit" className="rounded-md bg-gray-900 px-2 py-1 text-xs font-medium text-white hover:bg-gray-800">
              Go
            </button>
          </form>
          <a
            href={`/api/school/attendance/export?${exportParams.toString()}`}
            target="_top"
            rel="noopener"
            download
            className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            <Download className="h-3 w-3" /> CSV
          </a>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StatCard label="Roster total" value={data.stats.total} />
        <StatCard
          label="In"
          value={data.stats.present}
          color="#047857"
          href={filterHref(sp, { status: 'present' })}
        />
        <StatCard
          label="Picked up"
          value={data.stats.checked_out}
          color="#1d4ed8"
          href={filterHref(sp, { status: 'checked_out' })}
        />
        <StatCard
          label="Not yet"
          value={data.stats.not_yet}
          color="#d97706"
          href={filterHref(sp, { status: 'not_yet' })}
        />
        <StatCard
          label="Absent"
          value={data.stats.absent}
          color="#6b7280"
          href={filterHref(sp, { status: 'absent' })}
        />
      </div>

      {/* Recent events live feed */}
      {data.recent_events.length > 0 ? (
        <details className="rounded-lg border border-gray-200 bg-white p-3">
          <summary className="text-sm font-semibold text-gray-900 cursor-pointer">
            Recent events ({data.recent_events.length})
          </summary>
          <ul className="mt-2 divide-y divide-gray-50 text-xs">
            {data.recent_events.map((e) => (
              <li key={e.id} className="py-1.5">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-gray-500 tabular-nums w-12">{fmtTime(e.performed_at)}</span>
                  <EventTypeBadge t={e.event_type} />
                  <span className="text-gray-900">{e.student_first_name} {e.student_last_name}</span>
                  {e.event_type === 'check_out' ? (
                    <span className="text-gray-600">
                      by {e.picked_up_by_name ?? '?'}
                      {e.curbside ? ` · curbside${e.curbside_slot ? ` ${fmtSlot(e.curbside_slot)}` : ''}` : ''}
                    </span>
                  ) : null}
                  {e.performed_by_admin_email ? (
                    <span className="ml-auto text-[10px] text-amber-700">admin: {e.performed_by_admin_email}</span>
                  ) : e.performed_by_parent_name ? (
                    <span className="ml-auto text-[10px] text-gray-500">
                      by {e.performed_by_parent_name}
                      {e.source === 'kiosk' ? (
                        <span className="ml-1 rounded bg-violet-100 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-violet-800">kiosk</span>
                      ) : null}
                    </span>
                  ) : null}
                </div>
                {/* Parent's note for this event — surface inline so the
                    front desk doesn't miss it. Italic + indented so it
                    feels like an annotation, not a primary field. */}
                {e.notes ? (
                  <div className="ml-14 mt-0.5 text-[11px] italic text-gray-700 border-l-2 border-emerald-200 pl-2">
                    &ldquo;{e.notes}&rdquo;
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {/* Filter row */}
      <AutoSubmitForm className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-white p-3">
        <input
          type="search"
          name="q"
          defaultValue={sp.q ?? ''}
          placeholder="Search student or parent name…"
          className="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm placeholder:text-gray-400 focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-200"
        />
        {data.classrooms.length > 0 ? (
          <label className="text-xs text-gray-600">
            Classroom:{' '}
            <select name="classroom" defaultValue={sp.classroom ?? ''} className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm focus:border-emerald-600 focus:outline-none">
              <option value="">all</option>
              {data.classrooms.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="text-xs text-gray-600">
          Status:{' '}
          <select name="status" defaultValue={sp.status ?? ''} className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm focus:border-emerald-600 focus:outline-none">
            <option value="">all</option>
            <option value="present">In</option>
            <option value="checked_out">Picked up</option>
            <option value="not_yet">Not yet</option>
            <option value="absent">Absent</option>
          </select>
        </label>
        <label className="text-xs text-gray-600">
          Curbside:{' '}
          <select name="curbside" defaultValue={sp.curbside ?? ''} className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm focus:border-emerald-600 focus:outline-none">
            <option value="">any</option>
            <option value="yes">Curbside only</option>
            <option value="no">Walk-in only</option>
          </select>
        </label>
        {sp.date ? <input type="hidden" name="date" value={sp.date} /> : null}
        <PreserveEmbedParams current={sp} />
        <noscript>
          <button type="submit" className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800">
            Apply
          </button>
        </noscript>
        {isFiltered ? <a href={clearHref(sp, sp.date ? { date: sp.date } : {})} className="text-xs text-gray-500 hover:underline">clear</a> : null}
      </AutoSubmitForm>

      <div id="roster">
        <RosterTable rows={data.rows} dateIso={data.date_iso} isToday={data.is_today} />
      </div>

      {/* Compliance Reports — separate from the live view because
          operators pull date-range exports for state reporting and
          audits, not for "what's happening today." */}
      <div id="reports">
        <ReportsPanel classrooms={data.classrooms} studentOptions={data.all_students} />
      </div>

      {void school}
    </div>
  );
}

function EventTypeBadge({ t }: { t: string }) {
  const map: Record<string, string> = {
    check_in: 'bg-emerald-100 text-emerald-800',
    check_out: 'bg-blue-100 text-blue-800',
    absent: 'bg-zinc-200 text-zinc-700',
    manual_override: 'bg-amber-100 text-amber-800',
  };
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${map[t] ?? 'bg-gray-100 text-gray-700'}`}>
      {t.replace(/_/g, ' ')}
    </span>
  );
}

function fmtTime(s: string): string {
  const d = new Date(s);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: TZ });
}

// Curbside-slot canonical value like '14:30' → '2:30 pm'
function fmtSlot(v: string): string {
  const [hh, mm] = v.split(':').map((x) => parseInt(x, 10));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return v;
  const period = hh >= 12 ? 'pm' : 'am';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${period}`;
}

export const AttendanceDashboard: WidgetDefinition<AttendanceDashboardConfig, AttendanceDashboardData> = {
  id: 'attendance_dashboard',
  display_name: 'Attendance Dashboard',
  description:
    'School-wide attendance view: live counts, roster with check-in/out times, ' +
    'classroom + status filters, manual override actions, and CSV export.',
  category: 'student',
  default_config: attendanceDashboardDefaults,
  config_schema: attendanceDashboardSchema,
  default_size: { w: 12, h: 18 },
  Component,
  dataFetcher: fetcher,
  searchParamsAffectFetch: true,
};
