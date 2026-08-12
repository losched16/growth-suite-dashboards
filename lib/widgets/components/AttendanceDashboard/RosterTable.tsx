'use client';

// Roster table with inline accordion. Click a student → drawer with
// today's events + manual override form (mark absent / force check-in
// / force check-out). State is local; navigation/filters stay
// URL-state driven.

import { useState } from 'react';
import { ChevronRight, ChevronDown, AlertCircle, Download, ShieldCheck, Plus, X } from 'lucide-react';
import type { StudentRow } from './fetcher';
import type { CustomAttendanceStatus } from '@/lib/attendance/custom-statuses';
import { formatPickupTime } from '@/lib/attendance/pickup-times';

const TZ = 'America/Phoenix';
const EMDASH = '—';

// Literal Tailwind classes per stored color name (JIT-safe). Keep in
// sync with STATUS_COLORS in lib/attendance/custom-statuses.ts.
const STATUS_CHIP: Record<string, string> = {
  slate:  'bg-slate-200 text-slate-800',
  amber:  'bg-amber-100 text-amber-800',
  violet: 'bg-violet-100 text-violet-800',
  sky:    'bg-sky-100 text-sky-800',
  teal:   'bg-teal-100 text-teal-800',
  rose:   'bg-rose-100 text-rose-800',
  orange: 'bg-orange-100 text-orange-800',
  lime:   'bg-lime-100 text-lime-800',
};

// Map curbside_slot stored values ('14:30') to a display string.
function fmtCurbsideSlot(v: string | null): string | null {
  if (!v) return null;
  const [hh, mm] = v.split(':').map((s) => parseInt(s, 10));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return v;
  const period = hh >= 12 ? 'pm' : 'am';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${period}`;
}

export function RosterTable({ rows, dateIso, isToday, customStatuses = [] }: {
  rows: StudentRow[]; dateIso: string; isToday: boolean; customStatuses?: CustomAttendanceStatus[];
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (rows.length === 0) {
    return (
      <div className="space-y-2">
        <StatusCategoriesManager categories={customStatuses} />
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-sm text-gray-500">
          No students match the current filters.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
    <StatusCategoriesManager categories={customStatuses} />
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table className="w-full text-sm">
        <thead className="border-b border-gray-100 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th className="w-6 px-2 py-2" />
            <th className="px-3 py-2 font-medium">Student</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Pickup at</th>
            <th className="px-3 py-2 font-medium">In</th>
            <th className="px-3 py-2 font-medium">Out</th>
            <th className="px-3 py-2 font-medium">By</th>
            <th className="px-3 py-2 font-medium text-center">Curbside</th>
            <th className="px-3 py-2 font-medium">Notes</th>
            <th className="px-3 py-2 font-medium">Authorized pickup</th>
            <th className="px-3 py-2 font-medium text-rose-700">Do NOT pickup</th>
            <th className="px-3 py-2 font-medium">Parent PINs</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((r, i) => {
            const open = expanded === r.student_id;
            // Classroom-grouped presentation: rows arrive sorted by
            // classroom, so a header row marks each new section.
            const newSection = i === 0 || r.classroom !== rows[i - 1].classroom;
            return (
              <FragmentRow
                key={r.student_id}
                row={r}
                open={open}
                onToggle={() => setExpanded(open ? null : r.student_id)}
                dateIso={dateIso}
                isToday={isToday}
                sectionLabel={newSection ? (r.classroom ?? 'No classroom') : null}
                customStatuses={customStatuses}
              />
            );
          })}
        </tbody>
      </table>
    </div>
    </div>
  );
}

function FragmentRow({
  row: r, open, onToggle, dateIso, isToday, sectionLabel, customStatuses,
}: {
  row: StudentRow;
  open: boolean;
  onToggle: () => void;
  dateIso: string;
  isToday: boolean;
  sectionLabel: string | null;
  customStatuses: CustomAttendanceStatus[];
}) {
  return (
    <>
      {sectionLabel !== null ? (
        <tr className="bg-emerald-50/70 border-y border-emerald-200">
          <td colSpan={12} className="px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-emerald-900">
            {sectionLabel}
          </td>
        </tr>
      ) : null}
      <tr
        onClick={onToggle}
        className={`cursor-pointer ${open ? 'bg-emerald-50/50' : 'hover:bg-gray-50'}`}
      >
        <td className="px-2 py-2 align-top text-gray-400">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </td>
        <td className="px-3 py-2 align-top">
          <div className="flex items-center gap-1 flex-wrap">
            <span className="font-medium text-gray-900">{r.first_name} {r.last_name}</span>
            {r.last_admin_override_email ? (
              <span
                title={`Last admin override by ${r.last_admin_override_email}${
                  r.last_admin_override_at ? ` at ${fmtTime(r.last_admin_override_at)}` : ''
                }`}
                className="inline-flex items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-medium text-amber-900"
              >
                <ShieldCheck className="h-2.5 w-2.5" /> admin
              </span>
            ) : null}
          </div>
          <div className="text-[10px] text-gray-500">{r.primary_parent_name}</div>
        </td>
        <td className="px-3 py-2 align-top">
          <StatusBadge status={r.status} custom={r.custom_status} categories={customStatuses} />
        </td>
        <td className="px-3 py-2 align-top">
          {r.pickup_time ? (
            <span className="inline-block rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-900 whitespace-nowrap tabular-nums">
              {formatPickupTime(r.pickup_time)}
            </span>
          ) : (
            <span className="text-gray-400">{EMDASH}</span>
          )}
        </td>
        <td className="px-3 py-2 align-top text-xs text-gray-700">
          {r.first_check_in_at ? fmtTime(r.first_check_in_at) : EMDASH}
        </td>
        <td className="px-3 py-2 align-top text-xs text-gray-700">
          {r.last_check_out_at ? fmtTime(r.last_check_out_at) : EMDASH}
        </td>
        <td className="px-3 py-2 align-top text-xs text-gray-700">
          {r.picked_up_by_name ?? EMDASH}
        </td>
        <td className="px-3 py-2 align-top text-center">
          {r.curbside ? (
            <span className="inline-block rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-900 whitespace-nowrap">
              {fmtCurbsideSlot(r.curbside_slot) ?? 'curbside'}
            </span>
          ) : (
            <span className="text-gray-400">{EMDASH}</span>
          )}
        </td>
        <td className="px-3 py-2 align-top text-xs text-gray-700 max-w-[16rem]">
          {/* Office note first (admin-entered, parents never see it),
              then any parent notes from today's events. */}
          {r.admin_notes ? (
            <span
              title={`Office note (not visible to parents): ${r.admin_notes}`}
              className="block truncate font-medium text-amber-800"
            >
              🔒 {r.admin_notes}
            </span>
          ) : null}
          {r.todays_notes ? (
            <span
              title={r.todays_notes}
              className="block truncate italic text-gray-700"
            >
              &ldquo;{r.todays_notes}&rdquo;
            </span>
          ) : null}
          {!r.admin_notes && !r.todays_notes ? (
            <span className="text-gray-400">{EMDASH}</span>
          ) : null}
        </td>
        <td className="px-3 py-2 align-top text-[11px] text-gray-700 max-w-[14rem]">
          {r.authorized_pickup
            ? <span className="block" title={r.authorized_pickup}>{r.authorized_pickup}</span>
            : <span className="text-gray-400">{EMDASH}</span>}
        </td>
        <td className="px-3 py-2 align-top text-[11px] max-w-[12rem]">
          {r.do_not_pickup
            ? <span className="block font-medium text-rose-700" title={r.do_not_pickup}>⛔ {r.do_not_pickup}</span>
            : <span className="text-gray-400">{EMDASH}</span>}
        </td>
        <td className="px-3 py-2 align-top text-[11px] whitespace-nowrap">
          {r.parent_pins
            ? <span className="font-mono text-gray-800" title="Each active parent's kiosk PIN (first name + PIN)">{r.parent_pins}</span>
            : <span className="text-gray-400" title="No viewable PIN — set one from the Student Roster family panel">{EMDASH}</span>}
        </td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={12} className="bg-gray-50 p-0 border-y border-emerald-200">
            <Drawer row={r} dateIso={dateIso} isToday={isToday} customStatuses={customStatuses} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function Drawer({ row: r, dateIso, isToday, customStatuses }: {
  row: StudentRow; dateIso: string; isToday: boolean; customStatuses: CustomAttendanceStatus[];
}) {
  return (
    <div className="px-6 py-5 space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-sm">
        <div>
          <Label>Student</Label>
          <div className="text-gray-900 font-medium">{r.first_name} {r.last_name}</div>
          <div className="text-xs text-gray-600">{r.classroom ?? '(no classroom on file)'}</div>
        </div>
        <div>
          <Label>Primary parent</Label>
          <div className="text-gray-900">{r.primary_parent_name}</div>
          {r.primary_parent_email ? <div className="text-xs text-gray-600 break-all">{r.primary_parent_email}</div> : null}
        </div>
        <div>
          <Label>Today</Label>
          <Row2 k="Status" v={statusLabel(r.status)} />
          <Row2 k="Checked in" v={r.first_check_in_at ? fmtTime(r.first_check_in_at) : '—'} />
          <Row2 k="Picked up" v={r.last_check_out_at ? fmtTime(r.last_check_out_at) : '—'} />
          <Row2 k="Picked up by" v={r.picked_up_by_name ?? '—'} />
          {r.total_minutes !== null && r.total_minutes > 0 ? (
            <Row2 k="Duration" v={`${Math.floor(r.total_minutes / 60)}h ${r.total_minutes % 60}m`} />
          ) : null}
          <Row2 k="Events" v={String(r.event_count_today)} />
        </div>
      </div>

      {/* Parent notes left at check-in / check-out today. Highlighted
          so the front desk can scan them at a glance. */}
      {r.todays_notes ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50/50 px-3 py-2">
          <Label>Notes from parents today</Label>
          <p className="text-sm italic text-gray-800 whitespace-pre-wrap">
            &ldquo;{r.todays_notes}&rdquo;
          </p>
        </div>
      ) : null}

      {/* Office-only note on the day (migration 096). Editable here for
          any date; NEVER rendered in the parent portal. */}
      <AdminNotesEditor studentId={r.student_id} dateIso={dateIso} initial={r.admin_notes} />

      {/* Most-recent admin override on this student today — surfaced so
          operators have a clear audit trail without digging through the
          full events feed. */}
      {r.last_admin_override_email ? (
        <div className="rounded-md border border-amber-200 bg-amber-50/50 px-3 py-2 text-xs">
          <Label>Last admin override</Label>
          <div className="text-gray-800">
            <strong>{r.last_admin_override_email}</strong>
            {r.last_admin_override_at ? (
              <span className="text-gray-600"> · {fmtTime(r.last_admin_override_at)}</span>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Per-student CSV deep-links — quick exports for one kid */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-gray-500">Quick export for {r.first_name}:</span>
        {[
          { days: 7, label: 'Last 7 days' },
          { days: 30, label: 'Last 30 days' },
          { days: 60, label: 'Last 60 days' },
          { days: 90, label: 'Last 90 days' },
        ].map((p) => (
          <a
            key={p.days}
            href={`/api/school/attendance/export?format=daily&from=${isoDaysAgo(p.days - 1)}&to=${todayIso()}&student_id=${r.student_id}`}
            target="_top"
            rel="noopener"
            download
            className="inline-flex items-center gap-1 rounded border border-gray-300 bg-white px-2 py-0.5 text-[11px] text-gray-700 hover:bg-gray-50"
          >
            <Download className="h-3 w-3" /> {p.label}
          </a>
        ))}
      </div>

      {/* Manual override actions — only show for today (historical dates get time-fix only) */}
      {isToday ? (
        <ManualOverrideForm row={r} customStatuses={customStatuses} />
      ) : (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 flex items-start gap-2">
          <AlertCircle className="h-3.5 w-3.5 mt-0.5" />
          <span>
            Historical date ({dateIso}) — status buttons are today-only, but you can still correct the
            check-in / check-out times below.
          </span>
        </div>
      )}

      {/* Time corrections — works for today AND past dates. Voids the
          wrong event(s), keeps them for audit, recomputes the day. */}
      <TimeFixForm studentId={r.student_id} dateIso={dateIso} />
    </div>
  );
}

// Admin "the time is wrong" fix: pick the actual check-in or check-out
// time; the server voids that day's events of that type and writes one
// corrected manual_override event, so the day recomputes everywhere.
function TimeFixForm({ studentId, dateIso }: { studentId: string; dateIso: string }) {
  const [inTime, setInTime] = useState('');
  const [outTime, setOutTime] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save(eventType: 'check_in' | 'check_out', time: string) {
    if (busy || !time) return;
    setBusy(true); setErr(null);
    try {
      const fd = new FormData();
      fd.set('student_id', studentId);
      fd.set('event_type', eventType);
      fd.set('time', time);
      fd.set('date', dateIso);
      const r = await fetch('/api/school/attendance/set-time', { method: 'POST', body: fd });
      if (!r.ok) throw new Error((await r.text()) || 'failed');
      window.location.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border border-blue-200 bg-blue-50/40 p-3 space-y-2">
      <Label>Fix the recorded times (admin)</Label>
      <p className="text-[11px] text-gray-600">
        Overwrites the day&apos;s recorded time — the wrong entry is kept in the audit log as voided, and
        your correction (with your email) takes its place.
      </p>
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex items-end gap-1.5">
          <div>
            <div className="text-[11px] text-gray-600 mb-0.5">Check-in time</div>
            <input type="time" value={inTime} onChange={(e) => setInTime(e.target.value)}
              className="rounded border border-blue-200 bg-white px-2 py-1 text-sm text-gray-900" />
          </div>
          <button type="button" disabled={busy || !inTime} onClick={() => save('check_in', inTime)}
            className="rounded-md border border-blue-600 bg-white px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50">
            Set check-in
          </button>
        </div>
        <div className="flex items-end gap-1.5">
          <div>
            <div className="text-[11px] text-gray-600 mb-0.5">Check-out time</div>
            <input type="time" value={outTime} onChange={(e) => setOutTime(e.target.value)}
              className="rounded border border-blue-200 bg-white px-2 py-1 text-sm text-gray-900" />
          </div>
          <button type="button" disabled={busy || !outTime} onClick={() => save('check_out', outTime)}
            className="rounded-md border border-blue-600 bg-white px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50">
            Set check-out
          </button>
        </div>
      </div>
      {err ? <div className="text-xs text-red-700">{err}</div> : null}
    </div>
  );
}

// Office-only day note: editable textarea + save/clear. Persists on the
// daily_attendance row (survives check-in/out — unlike custom_status,
// the recompute trigger doesn't clear it) and is preserved across syncs.
// Parents never see it: the parent portal's attendance page reads only
// status/times and event notes.
function AdminNotesEditor({ studentId, dateIso, initial }: {
  studentId: string; dateIso: string; initial: string | null;
}) {
  const [text, setText] = useState(initial ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dirty = text.trim() !== (initial ?? '').trim();

  async function save(value: string) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.set('student_id', studentId);
      fd.set('date', dateIso);
      fd.set('notes', value);
      const r2 = await fetch('/api/school/attendance/admin-notes', { method: 'POST', body: fd });
      if (!r2.ok) throw new Error((await r2.text()) || 'failed');
      window.location.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border border-amber-300 bg-amber-50/60 px-3 py-2 space-y-1.5">
      <Label>Office notes — not visible to parents 🔒</Label>
      <textarea
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={2000}
        placeholder="e.g. Grandma picking up at 2pm — verify ID · left early for appointment"
        className="w-full rounded border border-amber-200 bg-white px-2 py-1.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-amber-400 focus:outline-none"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy || !dirty}
          onClick={() => save(text.trim())}
          className="rounded-md bg-amber-600 px-3 py-1 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save note'}
        </button>
        {initial ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => save('')}
            className="rounded-md border border-amber-300 bg-white px-3 py-1 text-xs font-medium text-amber-800 hover:bg-amber-50 disabled:opacity-50"
          >
            Clear note
          </button>
        ) : null}
        {err ? <span className="text-xs text-red-700">{err}</span> : null}
      </div>
    </div>
  );
}

function ManualOverrideForm({ row: r, customStatuses }: { row: StudentRow; customStatuses: CustomAttendanceStatus[] }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(eventType: 'check_in' | 'check_out' | 'absent', notes: string) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.set('student_id', r.student_id);
      fd.set('event_type', eventType);
      fd.set('notes', notes);
      const r2 = await fetch('/api/school/attendance/manual-override', { method: 'POST', body: fd });
      if (!r2.ok) {
        const t = await r2.text();
        throw new Error(t || 'failed');
      }
      window.location.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
      setBusy(false);
    }
  }

  // Set / clear the office-defined custom status for today.
  async function setCustom(statusKey: string) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.set('student_id', r.student_id);
      fd.set('status', statusKey); // '' clears
      const r2 = await fetch('/api/school/attendance/custom-status', { method: 'POST', body: fd });
      if (!r2.ok) throw new Error((await r2.text()) || 'failed');
      window.location.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border-2 border-emerald-200 bg-emerald-50/40 p-3 space-y-2">
      <Label>Manual override (admin)</Label>
      <p className="text-[11px] text-gray-600">
        Force a status change. Writes a `manual_override` audit row with your email — original events stay intact.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => submit('check_in', 'Admin manual check-in')}
          className="rounded-md border border-emerald-600 bg-white px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
        >
          Force check-in
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => submit('check_out', 'Admin manual check-out')}
          className="rounded-md border border-blue-600 bg-white px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50"
        >
          Force check-out
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => submit('absent', 'Admin marked absent')}
          className="rounded-md border border-zinc-600 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
        >
          Mark absent
        </button>
      </div>
      {customStatuses.length > 0 ? (
        <div className="pt-1 border-t border-emerald-100">
          <div className="text-[11px] text-gray-600 mb-1">
            Status category (cleared automatically by the next check-in/out):
          </div>
          <div className="flex flex-wrap gap-2">
            {customStatuses.map((c) => (
              <button
                key={c.key}
                type="button"
                disabled={busy || r.custom_status === c.key}
                onClick={() => setCustom(c.key)}
                className={`rounded-full px-3 py-1 text-xs font-medium disabled:opacity-60 ${STATUS_CHIP[c.color] ?? STATUS_CHIP.slate} ${r.custom_status === c.key ? 'ring-2 ring-emerald-500' : 'hover:brightness-95'}`}
              >
                {c.label}{r.custom_status === c.key ? ' ✓' : ''}
              </button>
            ))}
            {r.custom_status ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => setCustom('')}
                className="rounded-full border border-gray-300 bg-white px-3 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              >
                Clear status
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {err ? <div className="text-xs text-red-700">{err}</div> : null}
    </div>
  );
}

// Self-serve editor for the school's custom status categories. Collapsed
// to one small link so the dashboard stays clean; changes reload the page.
function StatusCategoriesManager({ categories }: { categories: CustomAttendanceStatus[] }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [color, setColor] = useState('violet');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function add() {
    if (busy || !label.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch('/api/school/attendance/status-categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: label.trim(), color }),
      });
      if (!r.ok) throw new Error((await r.text()) || 'failed');
      window.location.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
      setBusy(false);
    }
  }

  async function remove(key: string) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch('/api/school/attendance/status-categories', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      if (!r.ok) throw new Error((await r.text()) || 'failed');
      window.location.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-emerald-700"
        title="Create status categories (Field Trip, Sick, Late …) you can set on any student for the day"
      >
        <Plus className="h-3 w-3" /> Manage status categories
      </button>
      {open ? (
        <div className="w-full rounded-lg border border-gray-200 bg-white p-3 space-y-2 text-left">
          <div className="text-xs text-gray-600">
            Categories you create here appear as one-tap buttons in each student&apos;s row drawer and
            show as the student&apos;s status chip. A real check-in/out afterward clears the label automatically.
          </div>
          {categories.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {categories.map((c) => (
                <span key={c.key} className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_CHIP[c.color] ?? STATUS_CHIP.slate}`}>
                  {c.label}
                  <button type="button" disabled={busy} onClick={() => remove(c.key)} title={`Delete "${c.label}"`} className="hover:opacity-70">
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <div className="text-xs text-gray-400 italic">No custom categories yet.</div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
              placeholder="New category (e.g. Field Trip)"
              maxLength={24}
              className="rounded border border-gray-300 px-2 py-1 text-xs w-52"
            />
            <select value={color} onChange={(e) => setColor(e.target.value)} className="rounded border border-gray-300 px-1.5 py-1 text-xs">
              {Object.keys(STATUS_CHIP).map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_CHIP[color] ?? STATUS_CHIP.slate}`}>{label.trim() || 'preview'}</span>
            <button
              type="button"
              disabled={busy || !label.trim()}
              onClick={add}
              className="rounded-md border border-emerald-600 bg-white px-3 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
            >
              Add
            </button>
          </div>
          {err ? <div className="text-xs text-red-700">{err}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function StatusBadge({ status, custom, categories }: {
  status: StudentRow['status'];
  custom?: string | null;
  categories?: CustomAttendanceStatus[];
}) {
  // Office-set custom category displays INSTEAD of the derived status
  // (a later real check-in/out clears it server-side). Deleted-category
  // keys fall back to showing the raw key so nothing renders blank.
  if (custom) {
    const cat = (categories ?? []).find((c) => c.key === custom);
    return (
      <span
        title={`Office-set status — cleared automatically by the next check-in/out (underlying: ${statusLabel(status)})`}
        className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_CHIP[cat?.color ?? 'slate'] ?? STATUS_CHIP.slate}`}
      >
        {cat?.label ?? custom.replace(/_/g, ' ')}
      </span>
    );
  }
  const map: Record<StudentRow['status'], string> = {
    not_yet: 'bg-amber-100 text-amber-800',
    present: 'bg-emerald-100 text-emerald-800',
    checked_out: 'bg-blue-100 text-blue-800',
    absent: 'bg-zinc-200 text-zinc-700',
    partial: 'bg-amber-100 text-amber-800',
  };
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${map[status]}`}>
      {statusLabel(status)}
    </span>
  );
}

function statusLabel(s: StudentRow['status']): string {
  switch (s) {
    case 'not_yet': return 'Not yet';
    case 'present': return 'In';
    case 'checked_out': return 'Out';
    case 'absent': return 'Absent';
    case 'partial': return 'Partial';
  }
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] uppercase tracking-wide text-gray-500 font-semibold mb-1">{children}</div>;
}

function Row2({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3 text-xs">
      <span className="text-gray-500">{k}</span>
      <span className="text-gray-800 tabular-nums">{v}</span>
    </div>
  );
}

function fmtTime(s: string): string {
  const d = new Date(s);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: TZ });
}

function todayIso(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
function isoDaysAgo(n: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  const d = new Date(Date.UTC(Number(get('year')), Number(get('month')) - 1, Number(get('day'))));
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
