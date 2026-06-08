import { query } from '@/lib/db';
import type { SchoolContext, WidgetSearchParams } from '@/lib/widgets/types';
import type { AttendanceDashboardConfig } from './config';

export interface StudentRow {
  student_id: string;
  first_name: string;
  last_name: string;
  classroom: string | null;
  // Used by the program filter on program-scoped dashboards. Not
  // currently displayed in the table.
  program: string | null;
  primary_parent_name: string;
  primary_parent_email: string | null;
  status: 'present' | 'absent' | 'checked_out' | 'not_yet' | 'partial';
  first_check_in_at: string | null;
  last_check_out_at: string | null;
  picked_up_by_name: string | null;
  curbside: boolean;
  curbside_slot: string | null;
  // Parent-selected dismissal wave at morning check-in, format 'HH:MM'
  // (24h). null until they check in. Stored on attendance_events and
  // surfaced here from the most recent check-in event today.
  pickup_time: string | null;
  total_minutes: number | null;
  event_count_today: number;
  // Joined string of every parent note left on today's check-in /
  // check-out events for this student (most-recent last). Null when
  // no notes today.
  todays_notes: string | null;
  // Most recent admin who performed a manual override today (if any).
  // Surfaced inline on the roster row so the front desk can see at a
  // glance which records were operator-touched today.
  last_admin_override_email: string | null;
  last_admin_override_at: string | null;
}

export interface EventRow {
  id: string;
  student_id: string;
  student_first_name: string;
  student_last_name: string;
  event_type: string;
  performed_at: string;
  performed_by_parent_name: string | null;
  performed_by_admin_email: string | null;
  picked_up_by_name: string | null;
  curbside: boolean;
  curbside_slot: string | null;
  notes: string | null;
}

export interface PickupPersonRow {
  id: string;
  name: string;
  relationship: string;
  active: boolean;
  added_by_parent_name: string;
}

export interface AttendanceDashboardData {
  date_iso: string;                  // selected date (YYYY-MM-DD in tz)
  date_label: string;                // for display
  is_today: boolean;
  stats: {
    total: number;
    present: number;
    checked_out: number;
    absent: number;
    not_yet: number;
  };
  classrooms: string[];
  rows: StudentRow[];
  recent_events: EventRow[];         // last 25 today, for the live feed
  // Student dropdown options for the Compliance Reports panel — the
  // full active roster, not just today's filtered subset.
  all_students: Array<{ id: string; name: string }>;
}

interface DbStudentRow {
  student_id: string;
  first_name: string;
  last_name: string;
  classroom: string | null;
  // Used only by the program filter (Upper El, MYHS dashboards). Not
  // displayed.
  program: string | null;
  primary_parent_first: string | null;
  primary_parent_last: string | null;
  primary_parent_email: string | null;
  status: string | null;
  first_check_in_at: string | null;
  last_check_out_at: string | null;
  picked_up_by_name: string | null;
  curbside_pickup: boolean | null;
  curbside_slot: string | null;
  pickup_time: string | null;
  total_minutes: number | null;
  event_count_today: number;
  // Today's parent notes from check-in / check-out events for this
  // student, joined into a single string with " · " separators.
  todays_notes: string | null;
  last_admin_override_email: string | null;
  last_admin_override_at: string | null;
}

interface DbEventRow {
  id: string;
  student_id: string;
  student_first_name: string;
  student_last_name: string;
  event_type: string;
  performed_at: string;
  performed_by_parent_first: string | null;
  performed_by_parent_last: string | null;
  performed_by_admin_email: string | null;
  picked_up_by_name_snapshot: string | null;
  curbside: boolean;
  curbside_slot: string | null;
  notes: string | null;
}

// YYYY-MM-DD in the given IANA timezone.
function dateInTz(d: Date, tz: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(d);
}

export async function fetcher(
  school: SchoolContext,
  config: AttendanceDashboardConfig,
  searchParams?: WidgetSearchParams,
): Promise<AttendanceDashboardData> {
  const sp = searchParams ?? {};
  const tz = config.timezone || 'America/Phoenix';
  const today = dateInTz(new Date(), tz);
  const dateIso = (sp.date ?? today).trim() || today;
  // URL param wins; otherwise fall back to widget-config default
  // (set by per-classroom dashboards).
  const classroomFilter = (sp.classroom ?? config.default_classroom_filter ?? '').trim();
  // Program filter (only set by program-scoped dashboards: Upper El, MYHS).
  const programFilter = (sp.program ?? config.default_program_filter ?? '').trim();
  const statusFilter = (sp.status ?? '').trim();
  const curbsideFilter = (sp.curbside ?? '').trim();   // 'yes' | 'no' | ''
  const search = (sp.q ?? '').trim().toLowerCase();

  // One row per active student with their daily_attendance for the
  // selected date. Students with no daily_attendance row default to
  // 'not_yet'.
  const { rows: studentRows } = await query<DbStudentRow>(
    `WITH today_evs AS (
       SELECT * FROM attendance_events
        WHERE school_id = $1
          AND (performed_at AT TIME ZONE $3)::date = $2::date
     ),
     ev_counts AS (
       SELECT student_id, COUNT(*)::int AS n
       FROM today_evs GROUP BY student_id
     ),
     ev_notes AS (
       SELECT student_id,
              string_agg(notes, ' · ' ORDER BY performed_at)
                FILTER (WHERE notes IS NOT NULL AND btrim(notes) <> '') AS todays_notes
       FROM today_evs GROUP BY student_id
     ),
     last_curb_slot AS (
       SELECT DISTINCT ON (student_id)
              student_id, curbside_slot
         FROM today_evs
        WHERE event_type = 'check_out' AND curbside = true
        ORDER BY student_id, performed_at DESC
     ),
     last_pickup_time AS (
       -- Parent-selected dismissal wave on the morning check-in. We
       -- take the latest check_in event with a non-null pickup_time so
       -- a re-check-in updates the wave.
       SELECT DISTINCT ON (student_id)
              student_id, pickup_time
         FROM today_evs
        WHERE event_type = 'check_in' AND pickup_time IS NOT NULL
        ORDER BY student_id, performed_at DESC
     ),
     last_override AS (
       SELECT DISTINCT ON (student_id)
              student_id,
              performed_by_admin_email AS email,
              performed_at AS at
         FROM today_evs
        WHERE performed_by_admin_email IS NOT NULL
        ORDER BY student_id, performed_at DESC
     )
     SELECT
       s.id AS student_id,
       s.first_name, s.last_name,
       COALESCE(s.metadata->>'homeroom', s.metadata->>'classroom_name') AS classroom,
       s.metadata->>'program' AS program,
       p.first_name AS primary_parent_first,
       p.last_name AS primary_parent_last,
       p.email AS primary_parent_email,
       COALESCE(da.status, 'not_yet') AS status,
       da.first_check_in_at,
       da.last_check_out_at,
       da.picked_up_by_name,
       da.curbside_pickup,
       lcs.curbside_slot,
       lpt.pickup_time,
       da.total_minutes,
       COALESCE(ec.n, 0) AS event_count_today,
       en.todays_notes,
       lo.email AS last_admin_override_email,
       lo.at AS last_admin_override_at
     FROM students s
     LEFT JOIN daily_attendance da
       ON da.student_id = s.id AND da.school_id = s.school_id AND da.date = $2::date
     LEFT JOIN ev_counts ec ON ec.student_id = s.id
     LEFT JOIN ev_notes en ON en.student_id = s.id
     LEFT JOIN last_curb_slot lcs ON lcs.student_id = s.id
     LEFT JOIN last_pickup_time lpt ON lpt.student_id = s.id
     LEFT JOIN last_override lo ON lo.student_id = s.id
     LEFT JOIN LATERAL (
       SELECT first_name, last_name, email
       FROM parents pp
       WHERE pp.family_id = s.family_id AND pp.is_primary = true AND pp.status = 'active'
       ORDER BY pp.created_at LIMIT 1
     ) p ON true
     WHERE s.school_id = $1 AND s.status = 'active'
     ORDER BY classroom NULLS LAST, s.first_name`,
    [school.schoolId, dateIso, tz],
  );

  // Recent events for the live feed (top of dashboard).
  const { rows: evRows } = await query<DbEventRow>(
    `SELECT
       e.id, e.student_id, s.first_name AS student_first_name, s.last_name AS student_last_name,
       e.event_type, e.performed_at,
       p.first_name AS performed_by_parent_first, p.last_name AS performed_by_parent_last,
       e.performed_by_admin_email,
       e.picked_up_by_name_snapshot,
       e.curbside, e.curbside_slot, e.notes
     FROM attendance_events e
     JOIN students s ON s.id = e.student_id
     LEFT JOIN parents p ON p.id = e.performed_by_parent_id
     WHERE e.school_id = $1
       AND (e.performed_at AT TIME ZONE $3)::date = $2::date
     ORDER BY e.performed_at DESC
     LIMIT 25`,
    [school.schoolId, dateIso, tz],
  );

  const allRows: StudentRow[] = studentRows.map((r) => ({
    student_id: r.student_id,
    first_name: r.first_name,
    last_name: r.last_name,
    classroom: r.classroom,
    program: r.program,
    primary_parent_name: [r.primary_parent_first, r.primary_parent_last].filter(Boolean).join(' ').trim() || '(no name)',
    primary_parent_email: r.primary_parent_email,
    status: (r.status ?? 'not_yet') as StudentRow['status'],
    first_check_in_at: r.first_check_in_at,
    last_check_out_at: r.last_check_out_at,
    picked_up_by_name: r.picked_up_by_name,
    curbside: !!r.curbside_pickup,
    curbside_slot: r.curbside_slot,
    pickup_time: r.pickup_time,
    total_minutes: r.total_minutes,
    event_count_today: r.event_count_today,
    todays_notes: r.todays_notes,
    last_admin_override_email: r.last_admin_override_email,
    last_admin_override_at: r.last_admin_override_at,
  }));

  const classrooms = Array.from(new Set(allRows.map((r) => r.classroom).filter((c): c is string => !!c))).sort();

  const filtered = allRows.filter((r) => {
    if (classroomFilter && r.classroom !== classroomFilter) return false;
    if (programFilter && (r.program ?? '') !== programFilter) return false;
    if (statusFilter && r.status !== statusFilter) return false;
    if (curbsideFilter === 'yes' && !r.curbside) return false;
    if (curbsideFilter === 'no' && r.curbside) return false;
    if (search) {
      const hay = (r.first_name + ' ' + r.last_name + ' ' + r.primary_parent_name + ' ' + (r.primary_parent_email ?? '')).toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  const stats = {
    total: allRows.length,
    present: allRows.filter((r) => r.status === 'present' || r.status === 'partial').length,
    checked_out: allRows.filter((r) => r.status === 'checked_out').length,
    absent: allRows.filter((r) => r.status === 'absent').length,
    not_yet: allRows.filter((r) => r.status === 'not_yet').length,
  };

  const recentEvents: EventRow[] = evRows.map((r) => ({
    id: r.id,
    student_id: r.student_id,
    student_first_name: r.student_first_name,
    student_last_name: r.student_last_name,
    event_type: r.event_type,
    performed_at: r.performed_at,
    performed_by_parent_name: [r.performed_by_parent_first, r.performed_by_parent_last].filter(Boolean).join(' ').trim() || null,
    performed_by_admin_email: r.performed_by_admin_email,
    picked_up_by_name: r.picked_up_by_name_snapshot,
    curbside: r.curbside,
    curbside_slot: r.curbside_slot,
    notes: r.notes,
  }));

  const isToday = dateIso === today;
  const dateLabel = new Date(dateIso + 'T00:00:00').toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  // Full roster for the Reports panel's student picker (unfiltered).
  const all_students = allRows
    .map((r) => ({ id: r.student_id, name: `${r.first_name} ${r.last_name}` }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    date_iso: dateIso,
    date_label: dateLabel,
    is_today: isToday,
    stats,
    classrooms,
    rows: filtered,
    recent_events: recentEvents,
    all_students,
  };
}
