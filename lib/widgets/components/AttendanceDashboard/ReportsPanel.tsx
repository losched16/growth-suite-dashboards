'use client';

// Compliance reports panel. Presets (Today / Yesterday / Last 7 / 30 /
// 60 / 90 / This month / Last month / This school year) + custom date
// range + format selector. "Download CSV" builds a URL that hits
// /api/school/attendance/export with the right params and triggers a
// browser download. No server round-trip until the operator actually
// requests the file.
//
// The current iframe filters (classroom, status, search) are NOT
// applied automatically — compliance reports usually want the full
// roster regardless of the day's filter state. Operator can layer
// filters in via the dropdowns inside this panel.

import { useMemo, useState } from 'react';
import { Download, Calendar, FileSpreadsheet } from 'lucide-react';

interface Props {
  classrooms: string[];
  studentOptions: Array<{ id: string; name: string }>;
}

type Format = 'daily' | 'events' | 'monthly';
type Preset =
  | 'today' | 'yesterday' | 'last7' | 'last30' | 'last60' | 'last90'
  | 'this_month' | 'last_month' | 'school_year' | 'custom';

const TZ = 'America/Phoenix';

export function ReportsPanel({ classrooms, studentOptions }: Props) {
  const [preset, setPreset] = useState<Preset>('last60');
  const [from, setFrom] = useState<string>(() => isoDaysAgo(60));
  const [to, setTo] = useState<string>(() => todayInTz());
  const [format, setFormat] = useState<Format>('daily');
  const [classroom, setClassroom] = useState('');
  const [studentId, setStudentId] = useState('');

  // Resolved range from preset (custom overrides via state)
  const resolved = useMemo(() => {
    if (preset === 'custom') return { from, to };
    return rangeForPreset(preset);
  }, [preset, from, to]);

  const url = useMemo(() => {
    const p = new URLSearchParams();
    p.set('format', format);
    p.set('from', resolved.from);
    p.set('to', resolved.to);
    if (classroom) p.set('classroom', classroom);
    if (studentId) p.set('student_id', studentId);
    return `/api/school/attendance/export?${p.toString()}`;
  }, [format, resolved, classroom, studentId]);

  const rangeDays = useMemo(() => {
    const a = new Date(resolved.from + 'T00:00:00Z').getTime();
    const b = new Date(resolved.to + 'T00:00:00Z').getTime();
    return Math.round((b - a) / (24 * 3600 * 1000)) + 1;
  }, [resolved]);

  return (
    <div className="rounded-lg border-2 border-emerald-200 bg-emerald-50/30 p-4 space-y-4">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
            <FileSpreadsheet className="h-4 w-4 text-emerald-700" />
            Compliance reports
          </h3>
          <p className="mt-0.5 text-[11px] text-gray-600">
            Export attendance records for state reporting, audits, or family records.
          </p>
        </div>
      </div>

      {/* Preset chips */}
      <div className="flex flex-wrap gap-1.5">
        <PresetChip label="Today"           value="today"      active={preset} onClick={setPreset} />
        <PresetChip label="Yesterday"       value="yesterday"  active={preset} onClick={setPreset} />
        <PresetChip label="Last 7 days"     value="last7"      active={preset} onClick={setPreset} />
        <PresetChip label="Last 30 days"    value="last30"     active={preset} onClick={setPreset} />
        <PresetChip label="Last 60 days"    value="last60"     active={preset} onClick={setPreset} />
        <PresetChip label="Last 90 days"    value="last90"     active={preset} onClick={setPreset} />
        <PresetChip label="This month"      value="this_month" active={preset} onClick={setPreset} />
        <PresetChip label="Last month"      value="last_month" active={preset} onClick={setPreset} />
        <PresetChip label="This school year" value="school_year" active={preset} onClick={setPreset} />
        <PresetChip label="Custom…"        value="custom"     active={preset} onClick={setPreset} />
      </div>

      {/* Custom range pickers */}
      {preset === 'custom' ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-gray-700">
            <div className="flex items-center gap-1">
              <Calendar className="h-3 w-3" /> From
            </div>
            <input
              type="date"
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value)}
              className="mt-0.5 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm focus:border-emerald-600 focus:outline-none"
            />
          </label>
          <label className="text-xs text-gray-700">
            <div className="flex items-center gap-1">
              <Calendar className="h-3 w-3" /> To
            </div>
            <input
              type="date"
              value={to}
              min={from}
              onChange={(e) => setTo(e.target.value)}
              className="mt-0.5 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm focus:border-emerald-600 focus:outline-none"
            />
          </label>
        </div>
      ) : (
        <div className="text-[11px] text-gray-600">
          Range: <strong className="text-gray-800">{resolved.from}</strong> →{' '}
          <strong className="text-gray-800">{resolved.to}</strong>{' '}
          <span className="text-gray-500">({rangeDays} day{rangeDays === 1 ? '' : 's'})</span>
        </div>
      )}

      {/* Format + scope filters */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <label className="text-xs text-gray-700">
          <span className="block font-medium">Report format</span>
          <select
            value={format}
            onChange={(e) => setFormat(e.target.value as Format)}
            className="mt-0.5 w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-sm focus:border-emerald-600 focus:outline-none"
          >
            <option value="daily">Daily summary (one row per student per day)</option>
            <option value="events">Event log (every check-in / check-out / override)</option>
            <option value="monthly">Monthly summary (rolled up per month)</option>
          </select>
        </label>
        <label className="text-xs text-gray-700">
          <span className="block font-medium">Classroom</span>
          <select
            value={classroom}
            onChange={(e) => setClassroom(e.target.value)}
            className="mt-0.5 w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-sm focus:border-emerald-600 focus:outline-none"
          >
            <option value="">All classrooms</option>
            {classrooms.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-gray-700">
          <span className="block font-medium">Student</span>
          <select
            value={studentId}
            onChange={(e) => setStudentId(e.target.value)}
            className="mt-0.5 w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-sm focus:border-emerald-600 focus:outline-none"
          >
            <option value="">All students</option>
            {studentOptions.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex items-center gap-3 border-t border-emerald-200 pt-3">
        <a
          href={url}
          target="_top"
          rel="noopener"
          download
          className="inline-flex items-center gap-1.5 rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-800"
        >
          <Download className="h-3.5 w-3.5" /> Download CSV
        </a>
        <FormatDescription format={format} />
      </div>
    </div>
  );
}

function PresetChip({
  label,
  value,
  active,
  onClick,
}: {
  label: string;
  value: Preset;
  active: Preset;
  onClick: (v: Preset) => void;
}) {
  const selected = active === value;
  return (
    <button
      type="button"
      onClick={() => onClick(value)}
      className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
        selected
          ? 'bg-emerald-700 text-white'
          : 'border border-emerald-300 bg-white text-emerald-800 hover:bg-emerald-50'
      }`}
    >
      {label}
    </button>
  );
}

function FormatDescription({ format }: { format: Format }) {
  const t: Record<Format, string> = {
    daily: 'Columns: date, student, classroom, parent, status, check-in, check-out, hours, picked-up-by, curbside.',
    events: 'Columns: event_id, date, time, student, classroom, event_type, performed_by, picked_up_by, curbside, signature_captured, notes.',
    monthly: 'Columns: year_month, student, classroom, days_present, days_absent, days_partial, total_hours, curbside_pickup_days.',
  };
  return <span className="text-[11px] text-gray-600">{t[format]}</span>;
}

// ----- Preset → range resolver -----------------------------------------

function rangeForPreset(p: Exclude<Preset, 'custom'>): { from: string; to: string } {
  const today = todayInTz();
  switch (p) {
    case 'today':      return { from: today, to: today };
    case 'yesterday':  { const y = isoDaysAgo(1); return { from: y, to: y }; }
    case 'last7':      return { from: isoDaysAgo(6),  to: today };
    case 'last30':     return { from: isoDaysAgo(29), to: today };
    case 'last60':     return { from: isoDaysAgo(59), to: today };
    case 'last90':     return { from: isoDaysAgo(89), to: today };
    case 'this_month': return { from: monthStart(0), to: today };
    case 'last_month': return { from: monthStart(1), to: monthEnd(1) };
    case 'school_year':
      // School year boundary: July 1. If we're past July 1 this calendar year,
      // start = July 1 of this year. Otherwise start = July 1 of prior year.
      return { from: schoolYearStart(), to: today };
  }
}

function todayInTz(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
function isoDaysAgo(n: number): string {
  // Get today in school TZ, subtract n days
  const todayParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (t: string) => todayParts.find((p) => p.type === t)?.value ?? '00';
  const d = new Date(Date.UTC(Number(get('year')), Number(get('month')) - 1, Number(get('day'))));
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
function monthStart(monthsAgo: number): string {
  const todayParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (t: string) => todayParts.find((p) => p.type === t)?.value ?? '00';
  const d = new Date(Date.UTC(Number(get('year')), Number(get('month')) - 1 - monthsAgo, 1));
  return d.toISOString().slice(0, 10);
}
function monthEnd(monthsAgo: number): string {
  const todayParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (t: string) => todayParts.find((p) => p.type === t)?.value ?? '00';
  // Last day of (current month - monthsAgo) = first of next month - 1 day
  const d = new Date(Date.UTC(Number(get('year')), Number(get('month')) - monthsAgo, 0));
  return d.toISOString().slice(0, 10);
}
function schoolYearStart(): string {
  const todayParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const year = Number(todayParts.find((p) => p.type === 'year')?.value ?? '2025');
  const month = Number(todayParts.find((p) => p.type === 'month')?.value ?? '01');
  const startYear = month >= 7 ? year : year - 1;
  return `${startYear}-07-01`;
}
