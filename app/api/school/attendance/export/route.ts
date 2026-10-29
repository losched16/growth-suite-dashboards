// CSV exports for attendance. Date range is inclusive on both ends.
//
//   format=events    one row per attendance_event in the range (audit log)
//   format=daily     one row per (student, school day) in the range
//   format=monthly   one row per (student, year-month) in the range —
//                    days present / absent / total hours / curbside-pickup counts
//
// Date params (all optional; sensible defaults):
//   date=YYYY-MM-DD          single day (back-compat with original UI)
//   from=YYYY-MM-DD          range start
//   to=YYYY-MM-DD            range end
//
// Filters (all formats): classroom, status (daily only), student_id,
// family_id (every child in one family), q
//
// "School day" = a date on which at least 25% of the enrolled roster was present.
// Weekends, holidays and break weeks (a handful of kids in camp/intersession) are
// therefore never counted as absences. Students who DID attend on a low-turnout day
// still get their row in the daily report; the monthly roll-up counts school days
// only. A student with no record on a school day in the past shows as
// `no_check_in` (today, `not_yet`).
//
// Auth: school session cookie, or location_id + embed_token.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { checkEmbedToken } from '@/lib/auth/embed';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

// TODO: read schools.timezone when the column exists
const TZ = 'America/Phoenix';

interface Filters { classroom: string; status: string; studentId: string; familyId: string; q: string }

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;

  // Auth: school session cookie, OR location_id + embed_token. The
  // second path is REQUIRED for CRM-embedded dashboards: download links
  // navigate the top window, which doesn't carry the iframe's
  // partitioned session cookie — session-only auth made every export
  // fail with 'unauthorized' from inside the CRM.
  let schoolId: string | null = null;
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (session) schoolId = session.school_id;
  if (!schoolId) {
    const locId = (sp.get('location_id') ?? '').trim();
    const embedToken = (sp.get('embed_token') ?? '').trim();
    if (locId && embedToken && checkEmbedToken(locId, embedToken)) {
      const { rows } = await query<{ id: string }>(
        `SELECT id FROM schools WHERE ghl_location_id = $1`, [locId]);
      schoolId = rows[0]?.id ?? null;
    }
  }
  if (!schoolId) return new NextResponse('unauthorized', { status: 401 });
  const format = (sp.get('format') ?? 'daily').toLowerCase();
  const singleDate = (sp.get('date') ?? '').trim();
  const rangeFromRaw = (sp.get('from') ?? '').trim();
  const rangeToRaw = (sp.get('to') ?? '').trim();
  const filters: Filters = {
    classroom: (sp.get('classroom') ?? '').trim(),
    status: (sp.get('status') ?? '').trim(),
    studentId: (sp.get('student_id') ?? '').trim(),
    familyId: (sp.get('family_id') ?? '').trim(),
    q: (sp.get('q') ?? '').trim().toLowerCase(),
  };
  const uuid = /^[0-9a-f-]{36}$/i;
  if ((filters.studentId && !uuid.test(filters.studentId)) || (filters.familyId && !uuid.test(filters.familyId))) {
    return new NextResponse('invalid id', { status: 400 });
  }

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
  const scope = filters.familyId ? 'family' : filters.studentId ? 'student' : 'school';

  if (format === 'events') {
    csv = await buildEventsCsv(schoolId, from, to, filters);
    filename = `attendance-events-${scope}-${rangeTag}.csv`;
  } else if (format === 'monthly') {
    csv = await buildMonthlyCsv(schoolId, from, to, filters, today);
    filename = `attendance-monthly-${scope}-${rangeTag}.csv`;
  } else {
    csv = await buildDailyCsv(schoolId, from, to, filters, today);
    filename = `attendance-daily-${scope}-${rangeTag}.csv`;
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
  filters: Filters,
): Promise<string> {
  const { rows } = await query<{
    id: string;
    performed_at: string;
    student_first_name: string;
    student_last_name: string;
    student_number: string | null;
    family: string | null;
    grade: string | null;
    program: string | null;
    classroom: string | null;
    event_type: string;
    performed_by_parent_first: string | null;
    performed_by_parent_last: string | null;
    performed_by_admin_email: string | null;
    performed_by_name_snapshot: string | null;
    picked_up_by_name_snapshot: string | null;
    curbside: boolean;
    curbside_slot: string | null;
    source: string | null;
    has_signature: boolean;
    notes: string | null;
  }>(
    `SELECT e.id, e.performed_at,
            s.first_name AS student_first_name, s.last_name AS student_last_name,
            s.metadata->>'student_id' AS student_number,
            f.display_name AS family,
            s.metadata->>'grade_level' AS grade,
            COALESCE(s.metadata->>'program_name', s.metadata->>'program') AS program,
            COALESCE(s.metadata->>'homeroom', s.metadata->>'classroom_name') AS classroom,
            e.event_type,
            p.first_name AS performed_by_parent_first, p.last_name AS performed_by_parent_last,
            e.performed_by_admin_email,
            e.performed_by_name_snapshot,
            e.picked_up_by_name_snapshot,
            e.curbside, e.curbside_slot, e.source,
            EXISTS (SELECT 1 FROM attendance_signatures g WHERE g.event_id = e.id) AS has_signature,
            e.notes
     FROM attendance_events e
     JOIN students s ON s.id = e.student_id
     LEFT JOIN families f ON f.id = s.family_id
     LEFT JOIN parents p ON p.id = e.performed_by_parent_id
     WHERE e.school_id = $1
       AND e.voided_at IS NULL
       AND (e.performed_at AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date
       AND ($5::uuid IS NULL OR e.student_id = $5::uuid)
       AND ($6::uuid IS NULL OR s.family_id = $6::uuid)
     ORDER BY e.performed_at`,
    [schoolId, TZ, from, to, filters.studentId || null, filters.familyId || null],
  );

  const header = [
    'event_id', 'date', 'time', 'student_name', 'student_id', 'family', 'grade', 'program', 'classroom',
    'event_type', 'performed_by', 'picked_up_by', 'curbside', 'curbside_slot', 'source',
    'signature_captured', 'notes',
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
      : [r.performed_by_parent_first, r.performed_by_parent_last].filter(Boolean).join(' ').trim()
        || r.performed_by_name_snapshot || '';
    lines.push([
      r.id,
      fmtDate(performedAt),
      fmtTime(performedAt),
      `${r.student_first_name} ${r.student_last_name}`,
      r.student_number ?? '',
      r.family ?? '',
      r.grade ?? '',
      r.program ?? '',
      r.classroom ?? '',
      r.event_type,
      performer,
      r.picked_up_by_name_snapshot ?? '',
      r.curbside ? 'yes' : 'no',
      r.curbside_slot ?? '',
      r.source ?? '',
      r.has_signature ? 'yes' : 'no',
      r.notes ?? '',
    ].map(csvField).join(','));
  }
  return utf8BomPrefix() + lines.join('\r\n') + '\r\n';
}

// ============================================================================
// Shared day-by-student dataset behind the daily and monthly reports.
// One row per (student, school day). A school day is any date with at least one
// attendance record school-wide, so weekends/holidays/breaks never show up.
// Students with no record that day still get a row so absences are visible.
// ============================================================================
interface DayRow {
  date: string;
  weekday: string;
  is_school_day: boolean;
  student_id: string;
  first_name: string;
  last_name: string;
  student_number: string | null;
  family: string | null;
  grade: string | null;
  program: string | null;
  classroom: string | null;
  parent_names: string | null;
  parent_emails: string | null;
  parent_phones: string | null;
  status: string | null;
  custom_status: string | null;
  first_check_in_at: string | null;
  last_check_out_at: string | null;
  total_minutes: number | null;
  picked_up_by_name: string | null;
  curbside_pickup: boolean | null;
  admin_notes: string | null;
}

async function loadDayRows(
  schoolId: string,
  from: string,
  to: string,
  filters: Filters,
): Promise<DayRow[]> {
  const { rows } = await query<DayRow>(
    `WITH roster AS (
       SELECT count(*)::int AS n FROM students
        WHERE school_id = $1 AND status = 'active'
          AND lower(coalesce(metadata->>'enrollment_status','')) = 'enrolled'
     ),
     school_days AS (
       SELECT da.date,
              (count(*) FILTER (WHERE da.status IN ('present','checked_out','partial'))
                 >= 0.25 * GREATEST((SELECT n FROM roster), 1)) AS is_school_day
         FROM daily_attendance da
        WHERE da.school_id = $1 AND da.date BETWEEN $2::date AND $3::date
        GROUP BY da.date
     )
     SELECT
       d.is_school_day,
       to_char(d.date, 'YYYY-MM-DD') AS date,
       to_char(d.date, 'Dy') AS weekday,
       s.id AS student_id, s.first_name, s.last_name,
       s.metadata->>'student_id' AS student_number,
       f.display_name AS family,
       s.metadata->>'grade_level' AS grade,
       COALESCE(s.metadata->>'program_name', s.metadata->>'program') AS program,
       COALESCE(s.metadata->>'homeroom', s.metadata->>'classroom_name') AS classroom,
       par.names AS parent_names, par.emails AS parent_emails, par.phones AS parent_phones,
       da.status, da.custom_status,
       da.first_check_in_at, da.last_check_out_at,
       COALESCE(da.total_minutes, CASE WHEN da.last_check_out_at > da.first_check_in_at THEN (EXTRACT(EPOCH FROM (da.last_check_out_at - da.first_check_in_at)) / 60)::int END) AS total_minutes,
       da.picked_up_by_name, da.curbside_pickup, da.admin_notes
     FROM school_days d
     CROSS JOIN students s
     JOIN families f ON f.id = s.family_id
     LEFT JOIN daily_attendance da
       ON da.student_id = s.id AND da.school_id = s.school_id AND da.date = d.date
     LEFT JOIN LATERAL (
       SELECT string_agg(btrim(pp.first_name || ' ' || pp.last_name), '; ' ORDER BY pp.is_primary DESC, pp.created_at) AS names,
              string_agg(NULLIF(btrim(pp.email), ''), '; ' ORDER BY pp.is_primary DESC, pp.created_at) AS emails,
              string_agg(NULLIF(btrim(pp.phone), ''), '; ' ORDER BY pp.is_primary DESC, pp.created_at) AS phones
         FROM parents pp
        WHERE pp.family_id = s.family_id AND pp.status = 'active'
     ) par ON true
     WHERE s.school_id = $1 AND s.status = 'active'
       -- enrolled students, plus anyone who has attendance that day (keeps history for withdrawn kids)
       AND (lower(coalesce(s.metadata->>'enrollment_status','')) = 'enrolled' OR da.student_id IS NOT NULL)
       -- low-turnout days (breaks/camps) only list the kids who actually attended
       AND (d.is_school_day OR da.status IN ('present','checked_out','partial'))
       AND ($4::uuid IS NULL OR s.id = $4::uuid)
       AND ($5::uuid IS NULL OR s.family_id = $5::uuid)
     ORDER BY d.date, classroom NULLS LAST, s.first_name`,
    [schoolId, from, to, filters.studentId || null, filters.familyId || null],
  );
  return rows;
}

function effectiveStatus(r: DayRow, today: string): string {
  if (r.status && r.status !== 'not_yet') return r.status;
  // No check-in recorded: still "not yet" today, but a past school day is a miss.
  return r.date < today ? 'no_check_in' : 'not_yet';
}

function matchesText(r: DayRow, q: string): boolean {
  if (!q) return true;
  const hay = (r.first_name + ' ' + r.last_name + ' ' + (r.parent_names ?? '') + ' ' + (r.family ?? '')).toLowerCase();
  return hay.includes(q);
}

// ============================================================================
// Daily summary: one row per (student, school day) in the range.
// ============================================================================
async function buildDailyCsv(
  schoolId: string,
  from: string,
  to: string,
  filters: Filters,
  today: string,
): Promise<string> {
  const rows = await loadDayRows(schoolId, from, to, filters);

  const header = [
    'date', 'weekday', 'student_name', 'student_id', 'family', 'grade', 'program', 'classroom',
    'parents', 'parent_emails', 'parent_phones', 'status', 'office_status',
    'first_check_in', 'last_check_out', 'total_hours', 'picked_up_by', 'curbside', 'office_notes',
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    if (filters.classroom && r.classroom !== filters.classroom) continue;
    const status = effectiveStatus(r, today);
    if (filters.status && status !== filters.status && r.status !== filters.status) continue;
    if (!matchesText(r, filters.q)) continue;
    const hours = r.total_minutes !== null ? (r.total_minutes / 60).toFixed(2) : '';
    lines.push([
      r.date,
      r.weekday,
      `${r.first_name} ${r.last_name}`,
      r.student_number ?? '',
      r.family ?? '',
      r.grade ?? '',
      r.program ?? '',
      r.classroom ?? '',
      r.parent_names ?? '',
      r.parent_emails ?? '',
      r.parent_phones ?? '',
      status,
      r.custom_status ?? '',
      r.first_check_in_at ? fmtTime(new Date(r.first_check_in_at)) : '',
      r.last_check_out_at ? fmtTime(new Date(r.last_check_out_at)) : '',
      hours,
      r.picked_up_by_name ?? '',
      r.curbside_pickup ? 'yes' : '',
      r.admin_notes ?? '',
    ].map(csvField).join(','));
  }
  return utf8BomPrefix() + lines.join('\r\n') + '\r\n';
}

// ============================================================================
// Monthly summary: one row per (student, year-month) in the range, rolled up
// from the same school-day dataset so it always agrees with the daily report.
//   school_days   = school days in that month (within the range)
//   days_present  = status present / checked_out
//   days_partial  = status partial
//   days_absent   = marked absent, or no check-in on a past school day
//   attendance_rate = (present + partial) / school_days
// ============================================================================
async function buildMonthlyCsv(
  schoolId: string,
  from: string,
  to: string,
  filters: Filters,
  today: string,
): Promise<string> {
  const rows = await loadDayRows(schoolId, from, to, filters);

  interface Agg {
    year_month: string; r: DayRow;
    school_days: number; present: number; partial: number; absent: number; minutes: number; curbside: number;
  }
  const byKey = new Map<string, Agg>();
  for (const r of rows) {
    if (filters.classroom && r.classroom !== filters.classroom) continue;
    if (!matchesText(r, filters.q)) continue;
    const status = effectiveStatus(r, today);
    if (status === 'not_yet') continue; // today, not arrived yet — not a countable day
    if (!r.is_school_day) continue;     // break/camp day — not part of the school calendar
    const ym = r.date.slice(0, 7);
    const key = `${ym}|${r.student_id}`;
    let a = byKey.get(key);
    if (!a) { a = { year_month: ym, r, school_days: 0, present: 0, partial: 0, absent: 0, minutes: 0, curbside: 0 }; byKey.set(key, a); }
    a.school_days++;
    if (status === 'present' || status === 'checked_out') a.present++;
    else if (status === 'partial') a.partial++;
    else a.absent++;
    a.minutes += r.total_minutes ?? 0;
    if (r.curbside_pickup) a.curbside++;
  }

  const header = [
    'year_month', 'student_name', 'student_id', 'family', 'grade', 'program', 'classroom',
    'parents', 'parent_emails', 'school_days', 'days_present', 'days_partial', 'days_absent',
    'attendance_rate', 'total_hours', 'avg_hours_per_day_present', 'curbside_pickup_days',
  ];
  const lines = [header.join(',')];
  const sorted = [...byKey.values()].sort((x, y) =>
    x.year_month.localeCompare(y.year_month)
    || (x.r.classroom ?? '￿').localeCompare(y.r.classroom ?? '￿')
    || x.r.first_name.localeCompare(y.r.first_name));
  for (const a of sorted) {
    const attended = a.present + a.partial;
    lines.push([
      a.year_month,
      `${a.r.first_name} ${a.r.last_name}`,
      a.r.student_number ?? '',
      a.r.family ?? '',
      a.r.grade ?? '',
      a.r.program ?? '',
      a.r.classroom ?? '',
      a.r.parent_names ?? '',
      a.r.parent_emails ?? '',
      String(a.school_days),
      String(a.present),
      String(a.partial),
      String(a.absent),
      a.school_days ? `${Math.round((attended / a.school_days) * 100)}%` : '',
      (a.minutes / 60).toFixed(2),
      attended ? (a.minutes / 60 / attended).toFixed(2) : '',
      String(a.curbside),
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
  return '\uFEFF';
}
function isValidDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(s + 'T00:00:00Z').getTime());
}
