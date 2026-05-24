// CSV exports for attendance. Date range is inclusive on both ends.
//
//   format=events    one row per attendance_event in the range (audit log)
//   format=daily     one row per (student, date) in the range
//   format=monthly   one row per (student, year-month) in the range —
//                    days present / absent / total hours / curbside-pickup counts
//
// Date params (all optional; sensible defaults):
//   date=YYYY-MM-DD          single day (back-compat with original UI)
//   from=YYYY-MM-DD          range start
//   to=YYYY-MM-DD            range end
//
// Filters (all formats): classroom, status (daily only), student_id, q
//
// Auth: school session cookie.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

// TODO: read schools.timezone when the column exists
const TZ = 'America/Phoenix';

export async function GET(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return new NextResponse('unauthorized', { status: 401 });

  const sp = request.nextUrl.searchParams;
  const format = (sp.get('format') ?? 'daily').toLowerCase();
  const singleDate = (sp.get('date') ?? '').trim();
  const rangeFromRaw = (sp.get('from') ?? '').trim();
  const rangeToRaw = (sp.get('to') ?? '').trim();
  const classroom = (sp.get('classroom') ?? '').trim();
  const status = (sp.get('status') ?? '').trim();
  const studentId = (sp.get('student_id') ?? '').trim();
  const q = (sp.get('q') ?? '').trim().toLowerCase();

  const today = todayInTz();

  // Date range resolution:
  //   - if `date=` given → that single day
  //   - else if `from`+`to` given → inclusive range
  //   - else → just today
  let from: string;
  let to: string;
  if (singleDate) {
    from = singleDate;
    to = singleDate;
  } else if (rangeFromRaw || rangeToRaw) {
    from = rangeFromRaw || rangeToRaw || today;
    to = rangeToRaw || rangeFromRaw || today;
  } else {
    from = today;
    to = today;
  }
  if (!isValidDate(from) || !isValidDate(to)) {
    return new NextResponse('invalid date format — use YYYY-MM-DD', { status: 400 });
  }
  if (from > to) [from, to] = [to, from];

  let csv: string;
  let filename: string;
  const isRange = from !== to;
  const rangeTag = isRange ? `${from}_to_${to}` : from;

  if (format === 'events') {
    csv = await buildEventsCsv(session.school_id, from, to, { classroom, studentId, q });
    filename = `attendance-events-${rangeTag}.csv`;
  } else if (format === 'monthly') {
    csv = await buildMonthlyCsv(session.school_id, from, to, { classroom, studentId, q });
    filename = `attendance-monthly-${rangeTag}.csv`;
  } else {
    csv = await buildDailyCsv(session.school_id, from, to, { classroom, status, studentId, q });
    filename = `attendance-daily-${rangeTag}.csv`;
  }

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}

// ============================================================================
// Event log: one row per attendance_event, inclusive [from, to] in school TZ.
// ============================================================================
async function buildEventsCsv(
  schoolId: string,
  from: string,
  to: string,
  filters: { classroom: string; studentId: string; q: string },
): Promise<string> {
  const { rows } = await query<{
    id: string;
    performed_at: string;
    student_first_name: string;
    student_last_name: string;
    classroom: string | null;
    event_type: string;
    performed_by_parent_first: string | null;
    performed_by_parent_last: string | null;
    performed_by_admin_email: string | null;
    picked_up_by_name_snapshot: string | null;
    curbside: boolean;
    has_signature: boolean;
    notes: string | null;
  }>(
    `SELECT e.id, e.performed_at,
            s.first_name AS student_first_name, s.last_name AS student_last_name,
            COALESCE(s.metadata->>'homeroom', s.metadata->>'classroom_name') AS classroom,
            e.event_type,
            p.first_name AS performed_by_parent_first, p.last_name AS performed_by_parent_last,
            e.performed_by_admin_email,
            e.picked_up_by_name_snapshot,
            e.curbside,
            (e.signature_png IS NOT NULL AND length(e.signature_png) > 0) AS has_signature,
            e.notes
     FROM attendance_events e
     JOIN students s ON s.id = e.student_id
     LEFT JOIN parents p ON p.id = e.performed_by_parent_id
     WHERE e.school_id = $1
       AND (e.performed_at AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date
       AND ($5::uuid IS NULL OR e.student_id = $5::uuid)
     ORDER BY e.performed_at`,
    [schoolId, TZ, from, to, filters.studentId || null],
  );

  const header = [
    'event_id', 'date', 'time', 'student_name', 'classroom', 'event_type',
    'performed_by', 'picked_up_by', 'curbside', 'signature_captured', 'notes',
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    if (filters.classroom && r.classroom !== filters.classroom) continue;
    if (filters.q) {
      const hay = (r.student_first_name + ' ' + r.student_last_name + ' ' + (r.picked_up_by_name_snapshot ?? '')).toLowerCase();
      if (!hay.includes(filters.q)) continue;
    }
    const performedAt = new Date(r.performed_at);
    const performer = r.performed_by_admin_email
      ? `admin:${r.performed_by_admin_email}`
      : [r.performed_by_parent_first, r.performed_by_parent_last].filter(Boolean).join(' ').trim() || '';
    lines.push([
      r.id,
      fmtDate(performedAt),
      fmtTime(performedAt),
      `${r.student_first_name} ${r.student_last_name}`,
      r.classroom ?? '',
      r.event_type,
      performer,
      r.picked_up_by_name_snapshot ?? '',
      r.curbside ? 'yes' : 'no',
      r.has_signature ? 'yes' : 'no',
      r.notes ?? '',
    ].map(csvField).join(','));
  }
  return utf8BomPrefix() + lines.join('\r\n') + '\r\n';
}

// ============================================================================
// Daily summary: one row per (student, date) in the range. Students with no
// events on a given date still get a row with status='not_yet'/'absent'
// (depending on whether it's a school day — we treat any date in range as
// reportable; admin can filter out weekends client-side or pre-filter).
// ============================================================================
async function buildDailyCsv(
  schoolId: string,
  from: string,
  to: string,
  filters: { classroom: string; status: string; studentId: string; q: string },
): Promise<string> {
  // Cross-join active students with each date in [from, to], left join
  // daily_attendance so days with no events show as 'not_yet'.
  const { rows } = await query<{
    date: string;
    student_id: string;
    first_name: string;
    last_name: string;
    classroom: string | null;
    primary_parent_first: string | null;
    primary_parent_last: string | null;
    status: string | null;
    first_check_in_at: string | null;
    last_check_out_at: string | null;
    total_minutes: number | null;
    picked_up_by_name: string | null;
    curbside_pickup: boolean | null;
  }>(
    `WITH date_range AS (
       SELECT generate_series($2::date, $3::date, interval '1 day')::date AS date
     )
     SELECT
       dr.date,
       s.id AS student_id, s.first_name, s.last_name,
       COALESCE(s.metadata->>'homeroom', s.metadata->>'classroom_name') AS classroom,
       p.first_name AS primary_parent_first, p.last_name AS primary_parent_last,
       COALESCE(da.status, 'not_yet') AS status,
       da.first_check_in_at, da.last_check_out_at, da.total_minutes,
       da.picked_up_by_name, da.curbside_pickup
     FROM date_range dr
     CROSS JOIN students s
     LEFT JOIN daily_attendance da
       ON da.student_id = s.id AND da.school_id = s.school_id AND da.date = dr.date
     LEFT JOIN LATERAL (
       SELECT first_name, last_name
       FROM parents pp
       WHERE pp.family_id = s.family_id AND pp.is_primary = true AND pp.status = 'active'
       ORDER BY pp.created_at LIMIT 1
     ) p ON true
     WHERE s.school_id = $1 AND s.status = 'active'
       AND ($4::uuid IS NULL OR s.id = $4::uuid)
     ORDER BY dr.date, classroom NULLS LAST, s.first_name`,
    [schoolId, from, to, filters.studentId || null],
  );

  const header = [
    'date', 'student_name', 'classroom', 'primary_parent', 'status',
    'first_check_in', 'last_check_out', 'total_hours', 'picked_up_by', 'curbside',
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    if (filters.classroom && r.classroom !== filters.classroom) continue;
    if (filters.status && r.status !== filters.status) continue;
    if (filters.q) {
      const hay = (r.first_name + ' ' + r.last_name + ' ' + (r.primary_parent_first ?? '') + ' ' + (r.primary_parent_last ?? '')).toLowerCase();
      if (!hay.includes(filters.q)) continue;
    }
    const dateStr = typeof r.date === 'string' ? r.date.slice(0, 10) : fmtDate(r.date as unknown as Date);
    const hours = r.total_minutes !== null ? (r.total_minutes / 60).toFixed(2) : '';
    const checkIn = r.first_check_in_at ? fmtTime(new Date(r.first_check_in_at)) : '';
    const checkOut = r.last_check_out_at ? fmtTime(new Date(r.last_check_out_at)) : '';
    lines.push([
      dateStr,
      `${r.first_name} ${r.last_name}`,
      r.classroom ?? '',
      [r.primary_parent_first, r.primary_parent_last].filter(Boolean).join(' '),
      r.status ?? 'not_yet',
      checkIn,
      checkOut,
      hours,
      r.picked_up_by_name ?? '',
      r.curbside_pickup ? 'yes' : '',
    ].map(csvField).join(','));
  }
  return utf8BomPrefix() + lines.join('\r\n') + '\r\n';
}

// ============================================================================
// Monthly summary: one row per (student, year-month) in the range.
// days_present  = days with status in ('present','checked_out','partial')
// days_absent   = days with status='absent'
// days_not_yet  = days with status='not_yet' (i.e. roster-day with no events)
// total_hours   = SUM(total_minutes) / 60
// curbside_days = days where curbside_pickup=true
// ============================================================================
async function buildMonthlyCsv(
  schoolId: string,
  from: string,
  to: string,
  filters: { classroom: string; studentId: string; q: string },
): Promise<string> {
  const { rows } = await query<{
    year_month: string;
    student_id: string;
    first_name: string;
    last_name: string;
    classroom: string | null;
    days_present: number;
    days_absent: number;
    days_not_yet: number;
    days_partial: number;
    total_minutes: number;
    curbside_days: number;
  }>(
    `SELECT
       to_char(da.date, 'YYYY-MM') AS year_month,
       s.id AS student_id, s.first_name, s.last_name,
       COALESCE(s.metadata->>'homeroom', s.metadata->>'classroom_name') AS classroom,
       COUNT(*) FILTER (WHERE da.status IN ('present','checked_out')) AS days_present,
       COUNT(*) FILTER (WHERE da.status = 'absent') AS days_absent,
       0 AS days_not_yet,
       COUNT(*) FILTER (WHERE da.status = 'partial') AS days_partial,
       COALESCE(SUM(da.total_minutes), 0) AS total_minutes,
       COUNT(*) FILTER (WHERE da.curbside_pickup = true) AS curbside_days
     FROM daily_attendance da
     JOIN students s ON s.id = da.student_id
     WHERE da.school_id = $1
       AND da.date BETWEEN $2::date AND $3::date
       AND s.status = 'active'
       AND ($4::uuid IS NULL OR s.id = $4::uuid)
     GROUP BY year_month, s.id, s.first_name, s.last_name, classroom
     ORDER BY year_month, classroom NULLS LAST, s.first_name`,
    [schoolId, from, to, filters.studentId || null],
  );

  const header = [
    'year_month', 'student_name', 'classroom',
    'days_present', 'days_absent', 'days_partial',
    'total_hours', 'curbside_pickup_days',
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    if (filters.classroom && r.classroom !== filters.classroom) continue;
    if (filters.q) {
      const hay = (r.first_name + ' ' + r.last_name).toLowerCase();
      if (!hay.includes(filters.q)) continue;
    }
    lines.push([
      r.year_month,
      `${r.first_name} ${r.last_name}`,
      r.classroom ?? '',
      String(r.days_present),
      String(r.days_absent),
      String(r.days_partial),
      (r.total_minutes / 60).toFixed(2),
      String(r.curbside_days),
    ].map(csvField).join(','));
  }
  return utf8BomPrefix() + lines.join('\r\n') + '\r\n';
}

// ----- helpers ----------------------------------------------------------

function todayInTz(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
function fmtDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}
function fmtTime(d: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: true,
  }).format(d);
}
function csvField(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function utf8BomPrefix(): string {
  return '﻿';
}
function isValidDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(s + 'T00:00:00Z').getTime());
}
