// Student Roster fetcher. Pulls all active students with their classroom +
// most-recent enrollment + family + parent name. Applies URL filters and
// returns a paginated slice.

import { query } from '@/lib/db';
import type { SchoolContext, WidgetSearchParams } from '@/lib/widgets/types';
import type { StudentRosterConfig } from './config';

export interface RosterStudent {
  student_id: string;
  family_id: string;
  family_display_name: string | null;
  primary_parent_name: string;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  date_of_birth: string | null;
  gender: string | null;
  status: string | null;
  classroom_name: string | null;
  lead_teacher_name: string | null;
  schedule: string | null;
  academic_year: string | null;
  program: string | null;
  homeroom: string | null;
  allergy: string | null;
  iep: string | null;
  five04_plan: string | null;
  has_allergy: boolean;
  has_iep_or_504: boolean;
  // Lightweight count for the inline Documents cell on the roster. The
  // actual list is fetched lazily via /api/school/documents/list when
  // the operator clicks the cell.
  documents_count: number;
  // Lunch selection (from student.metadata.organic_lunch). Free-text
  // because schools name their tiers differently.
  lunch: string | null;
  has_lunch: boolean;          // true if anything other than declined / null
  // Today's attendance status — joined from daily_attendance using the
  // widget's configured timezone. 'not_yet' means we have no row for
  // today yet (default state at the start of each day).
  attendance_status: 'present' | 'partial' | 'checked_out' | 'absent' | 'not_yet';
  attendance_check_in_at: string | null;
  attendance_check_out_at: string | null;
  // Curbside pickup info — daily_attendance.curbside_pickup is the
  // canonical "did/will they curbside today" flag; slot comes from the
  // most recent check_out event with curbside=true.
  curbside_today: boolean;
  curbside_slot: string | null;
  search_haystack: string;
}

export interface StudentRosterData {
  total_students: number;
  filtered: RosterStudent[];
  page_rows: RosterStudent[];
  page: number;
  per_page: number;
  page_count: number;
  options: {
    programs: string[];
    homerooms: string[];
    schedules: string[];
    teachers: string[];
    genders: string[];
    lunches: string[];
    attendance_statuses: string[];
  };
  // For Allergies view
  allergies_by_homeroom: Array<{
    homeroom: string;
    students: RosterStudent[];
  }>;
}

interface DbRow {
  student_id: string;
  family_id: string;
  family_display_name: string | null;
  primary_first: string | null;
  primary_last: string | null;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  date_of_birth: string | null;
  gender: string | null;
  enrollment_status: string | null;
  academic_year: string | null;
  classroom_name: string | null;
  lead_teacher_name: string | null;
  schedule: string | null;
  metadata: Record<string, unknown>;
  documents_count: number;
  attendance_status: string | null;
  attendance_first_check_in_at: string | null;
  attendance_last_check_out_at: string | null;
  attendance_curbside: boolean | null;
  curbside_slot: string | null;
}

export async function fetcher(
  school: SchoolContext,
  config: StudentRosterConfig,
  searchParams?: WidgetSearchParams,
): Promise<StudentRosterData> {
  const { rows } = await query<DbRow>(
    `SELECT
       s.id AS student_id,
       f.id AS family_id,
       f.display_name AS family_display_name,
       (SELECT first_name FROM parents pp WHERE pp.family_id = f.id AND pp.is_primary = true LIMIT 1) AS primary_first,
       (SELECT last_name FROM parents pp WHERE pp.family_id = f.id AND pp.is_primary = true LIMIT 1) AS primary_last,
       s.first_name, s.last_name, s.preferred_name, s.date_of_birth, s.gender,
       e.status AS enrollment_status,
       e.academic_year,
       c.name AS classroom_name,
       c.lead_teacher_name,
       e.schedule,
       s.metadata,
       COALESCE(dc.n, 0) AS documents_count,
       da.status              AS attendance_status,
       da.first_check_in_at   AS attendance_first_check_in_at,
       da.last_check_out_at   AS attendance_last_check_out_at,
       da.curbside_pickup     AS attendance_curbside,
       cs.curbside_slot       AS curbside_slot
     FROM students s
     JOIN families f ON f.id = s.family_id
     LEFT JOIN LATERAL (
       SELECT * FROM enrollments e2 WHERE e2.student_id = s.id ORDER BY e2.created_at DESC LIMIT 1
     ) e ON true
     LEFT JOIN classrooms c ON c.id = e.classroom_id
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS n FROM student_documents sd WHERE sd.student_id = s.id
     ) dc ON true
     LEFT JOIN daily_attendance da
       ON da.student_id = s.id
      AND da.school_id  = s.school_id
      AND da.date       = ((now() AT TIME ZONE $2)::date)
     LEFT JOIN LATERAL (
       -- Most recent curbside slot from today's events. Considers ALL
       -- event types — check_in (morning intent) AND check_out (actual
       -- curbside pickup). Migration 033 broadened the trigger to do
       -- the same on daily_attendance.curbside_pickup.
       SELECT curbside_slot
         FROM attendance_events
        WHERE student_id = s.id
          AND school_id  = s.school_id
          AND curbside   = true
          AND curbside_slot IS NOT NULL
          AND (performed_at AT TIME ZONE $2)::date = ((now() AT TIME ZONE $2)::date)
        ORDER BY performed_at DESC LIMIT 1
     ) cs ON true
     WHERE s.school_id = $1 AND s.status = 'active'
     ORDER BY s.first_name`,
    // Hardcoded DG timezone for now. If a future widget needs to do
    // this for another school, lift to widget config.
    [school.schoolId, 'America/Phoenix'],
  );

  const all: RosterStudent[] = rows.map((r) => {
    const md = r.metadata ?? {};
    const allergy = typeof md.allergy === 'string' ? md.allergy : null;
    const iep = typeof md.iep === 'string' ? md.iep : null;
    const five04 = typeof md.five04_plan === 'string' ? md.five04_plan : null;
    const program = typeof md.program === 'string' ? md.program : null;
    const homeroom = typeof md.homeroom === 'string' ? md.homeroom : null;
    const lunch = typeof md.organic_lunch === 'string' ? md.organic_lunch : null;
    const lunchLower = (lunch ?? '').toLowerCase();
    // "has lunch" = anything other than declined/blank. Declined values
    // start with "I decline" in DGM's GHL data, but we also tolerate a
    // bare "declined" string for robustness.
    const has_lunch = !!lunch && !lunchLower.includes('decline');
    const primary = `${r.primary_first ?? ''} ${r.primary_last ?? ''}`.trim();
    const has_allergy = !!allergy && !['no', 'none', 'n/a', 'na', ''].includes(allergy.toLowerCase());
    const has_iep_or_504 = (!!iep && iep.toLowerCase() !== 'no') || (!!five04 && five04.toLowerCase() !== 'no');
    const haystack = [r.first_name, r.last_name, r.preferred_name ?? '', primary, r.family_display_name ?? '']
      .join(' ').toLowerCase();
    // daily_attendance.status is the canonical source. If no row exists
    // for today, the LEFT JOIN returns null → we surface that as
    // 'not_yet' (matches AttendanceDashboard's semantics).
    const attendance_status = (
      (r.attendance_status as RosterStudent['attendance_status']) ?? 'not_yet'
    );
    return {
      student_id: r.student_id,
      family_id: r.family_id,
      family_display_name: r.family_display_name,
      primary_parent_name: primary || '(unnamed)',
      first_name: r.first_name,
      last_name: r.last_name,
      preferred_name: r.preferred_name,
      date_of_birth: r.date_of_birth,
      gender: r.gender,
      status: r.enrollment_status,
      classroom_name: r.classroom_name,
      lead_teacher_name: r.lead_teacher_name,
      schedule: r.schedule,
      academic_year: r.academic_year,
      program,
      homeroom,
      allergy,
      iep,
      five04_plan: five04,
      has_allergy,
      has_iep_or_504,
      documents_count: Number(r.documents_count ?? 0),
      lunch,
      has_lunch,
      attendance_status,
      attendance_check_in_at: r.attendance_first_check_in_at,
      attendance_check_out_at: r.attendance_last_check_out_at,
      curbside_today: !!r.attendance_curbside,
      curbside_slot: r.curbside_slot,
      search_haystack: haystack,
    };
  });

  const uniq = (vals: Iterable<string | null | undefined>): string[] =>
    [...new Set([...vals].filter((v): v is string => !!v && v.trim().length > 0))].sort();

  const options = {
    programs: uniq(all.map((s) => s.program ?? s.classroom_name)),
    homerooms: uniq(all.map((s) => s.homeroom ?? s.classroom_name)),
    schedules: uniq(all.map((s) => s.schedule)),
    teachers: uniq(all.map((s) => s.lead_teacher_name)),
    genders: uniq(all.map((s) => s.gender)),
    lunches: uniq(all.map((s) => s.lunch)),
    attendance_statuses: ['present', 'partial', 'checked_out', 'absent', 'not_yet'],
  };

  const sp = searchParams ?? {};
  const search = (sp.q ?? '').trim().toLowerCase();
  const fProg = (sp.program ?? config.default_program_filter ?? '').trim();
  // URL param wins; otherwise fall back to the widget-config default.
  // Per-classroom dashboards set this in their layout so the roster
  // pre-scopes to one classroom on first render.
  const fHome = (sp.homeroom ?? config.default_homeroom_filter ?? '').trim();
  const fSched = (sp.schedule ?? '').trim();
  const fTeacher = (sp.lead_teacher ?? '').trim();
  const fGender = (sp.gender ?? '').trim();
  const allergiesOnly = sp.allergies_only === '1' || sp.allergies_only === 'true';
  const iepOnly = sp.iep_504_only === '1' || sp.iep_504_only === 'true';
  const fLunch = (sp.lunch ?? '').trim();
  const lunchOnly = sp.lunch_only === '1' || sp.lunch_only === 'true';
  const fAttendance = (sp.attendance_status ?? '').trim();
  const curbsideOnly = sp.curbside_only === '1' || sp.curbside_only === 'true';

  const filtered = all.filter((s) => {
    if (fProg && (s.program ?? s.classroom_name ?? '') !== fProg) return false;
    if (fHome && (s.homeroom ?? s.classroom_name ?? '') !== fHome) return false;
    if (fSched && (s.schedule ?? '') !== fSched) return false;
    if (fTeacher && (s.lead_teacher_name ?? '') !== fTeacher) return false;
    if (fGender && (s.gender ?? '') !== fGender) return false;
    if (allergiesOnly && !s.has_allergy) return false;
    if (iepOnly && !s.has_iep_or_504) return false;
    if (fLunch && (s.lunch ?? '') !== fLunch) return false;
    if (lunchOnly && !s.has_lunch) return false;
    if (fAttendance && s.attendance_status !== fAttendance) return false;
    if (curbsideOnly && !s.curbside_today) return false;
    if (search && !s.search_haystack.includes(search)) return false;
    return true;
  });

  const perPage = Math.max(25, Math.min(1000, Number(sp.per_page) || config.page_size || 100));
  const page = Math.max(1, Number(sp.page) || 1);
  const pageCount = Math.max(1, Math.ceil(filtered.length / perPage));
  const safePage = Math.min(page, pageCount);
  const start = (safePage - 1) * perPage;
  const pageRows = filtered.slice(start, start + perPage);

  // Allergies view: group by homeroom, only include students with allergies
  const allergyMap = new Map<string, RosterStudent[]>();
  for (const s of filtered.filter((x) => x.has_allergy)) {
    const home = s.homeroom ?? s.classroom_name ?? '(unassigned)';
    const list = allergyMap.get(home) ?? [];
    list.push(s);
    allergyMap.set(home, list);
  }
  const allergies_by_homeroom = [...allergyMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([homeroom, students]) => ({ homeroom, students }));

  return {
    total_students: all.length,
    filtered,
    page_rows: pageRows,
    page: safePage,
    per_page: perPage,
    page_count: pageCount,
    options,
    allergies_by_homeroom,
  };
}
