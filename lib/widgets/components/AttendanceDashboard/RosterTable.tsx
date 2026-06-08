'use client';

// Roster table with inline accordion. Click a student → drawer with
// today's events + manual override form (mark absent / force check-in
// / force check-out). State is local; navigation/filters stay
// URL-state driven.

import { useState } from 'react';
import { ChevronRight, ChevronDown, AlertCircle, Download, ShieldCheck } from 'lucide-react';
import type { StudentRow } from './fetcher';
import { formatPickupTime } from '@/lib/attendance/pickup-times';

const TZ = 'America/Phoenix';
const EMDASH = '—';

// Map curbside_slot stored values ('14:30') to a display string.
function fmtCurbsideSlot(v: string | null): string | null {
  if (!v) return null;
  const [hh, mm] = v.split(':').map((s) => parseInt(s, 10));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return v;
  const period = hh >= 12 ? 'pm' : 'am';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${period}`;
}

export function RosterTable({ rows, dateIso, isToday }: { rows: StudentRow[]; dateIso: string; isToday: boolean }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-sm text-gray-500">
        No students match the current filters.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table className="w-full text-sm">
        <thead className="border-b border-gray-100 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th className="w-6 px-2 py-2" />
            <th className="px-3 py-2 font-medium">Student</th>
            <th className="px-3 py-2 font-medium">Classroom</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Pickup at</th>
            <th className="px-3 py-2 font-medium">In</th>
            <th className="px-3 py-2 font-medium">Out</th>
            <th className="px-3 py-2 font-medium">By</th>
            <th className="px-3 py-2 font-medium text-center">Curbside</th>
            <th className="px-3 py-2 font-medium">Notes</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((r) => {
            const open = expanded === r.student_id;
            return (
              <Row
                key={r.student_id}
                row={r}
                open={open}
                onToggle={() => setExpanded(open ? null : r.student_id)}
                dateIso={dateIso}
                isToday={isToday}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Row({
  row: r, open, onToggle, dateIso, isToday,
}: {
  row: StudentRow;
  open: boolean;
  onToggle: () => void;
  dateIso: string;
  isToday: boolean;
}) {
  return (
    <>
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
        <td className="px-3 py-2 align-top text-xs text-gray-700">{r.classroom ?? EMDASH}</td>
        <td className="px-3 py-2 align-top"><StatusBadge status={r.status} /></td>
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
          {r.todays_notes ? (
            <span
              title={r.todays_notes}
              className="block truncate italic text-gray-700"
            >
              &ldquo;{r.todays_notes}&rdquo;
            </span>
          ) : (
            <span className="text-gray-400">{EMDASH}</span>
          )}
        </td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={9} className="bg-gray-50 p-0 border-y border-emerald-200">
            <Drawer row={r} dateIso={dateIso} isToday={isToday} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function Drawer({ row: r, dateIso, isToday }: { row: StudentRow; dateIso: string; isToday: boolean }) {
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

      {/* Manual override actions — only show for today (historical dates are read-only) */}
      {isToday ? (
        <ManualOverrideForm row={r} />
      ) : (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 flex items-start gap-2">
          <AlertCircle className="h-3.5 w-3.5 mt-0.5" />
          <span>
            Historical date ({dateIso}). Corrections are append-only via manual_override events — surfaced
            here in a future iteration. For now, today&apos;s overrides only.
          </span>
        </div>
      )}
    </div>
  );
}

function ManualOverrideForm({ row: r }: { row: StudentRow }) {
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
      {err ? <div className="text-xs text-red-700">{err}</div> : null}
    </div>
  );
}

function StatusBadge({ status }: { status: StudentRow['status'] }) {
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
