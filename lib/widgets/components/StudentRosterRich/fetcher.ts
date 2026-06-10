// Student Roster fetcher. Pulls all active students with their classroom +
// most-recent enrollment + family + parent name. Applies URL filters and
// returns a paginated slice.

import { query } from '@/lib/db';
import type { SchoolContext, WidgetSearchParams } from '@/lib/widgets/types';
import type { StudentRosterConfig } from './config';

// Filler / no-detail values teachers commonly see in legacy GHL data.
// Treat these as "no useful prose" — when the field is just "Yes" or
// "No" we'd rather pick a real description from a fallback source.
const NULLISH_TEXT = new Set(['', 'no', 'none', 'n/a', 'na', 'no.', 'none.', 'yes', 'yes.']);

// Pick the most informative text out of any number of candidates.
// Priority: longest non-nullish string wins. Falls back to the bare
// "Yes" / "No" flag if NOTHING has prose, so the caller can still tell
// "there is no detail" from "this kid genuinely has no allergy".
function bestText(...candidates: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const c of candidates) {
    if (!c) continue;
    const t = c.trim();
    if (!t) continue;
    if (NULLISH_TEXT.has(t.toLowerCase())) continue;
    if (!best || t.length > best.length) best = t;
  }
  if (best) return best;
  // No prose found — return the first non-empty raw value if any, so
  // the column can still show the legacy "Yes" flag instead of "—".
  for (const c of candidates) {
    if (!c) continue;
    const t = c.trim();
    if (!t) continue;
    if (t.toLowerCase() === 'no' || t.toLowerCase() === 'none' || t.toLowerCase() === 'n/a' || t.toLowerCase() === 'na') {
      continue;
    }
    return t;
  }
  return null;
}

// True when the value indicates "yes there's something here" — used to
// flip the has_allergy badge on. "Yes" with no prose still flips it,
// so teachers see a flag and chase down the detail.
function isMeaningfulFlag(v: string | null | undefined): boolean {
  if (!v) return false;
  const t = v.trim().toLowerCase();
  if (!t) return false;
  return !['no', 'none', 'n/a', 'na', 'no.', 'none.'].includes(t);
}

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
  tuition: string | null;
  allergy: string | null;
  special_instructions: string | null;
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
  // Notes left during today's most recent check_in event. Surface as
  // a column so teachers can see "had a rough morning" / "needs nap
  // by 10:30" without opening the attendance dashboard.
  attendance_notes: string | null;
  // People who are NOT authorized to pick up this kid (custody
  // arrangements, no-contact orders). Surfaced as a column so the
  // teacher at the door doesn't have to open the family accordion to
  // know who to refuse. Empty array = no restrictions.
  pickup_restrictions: Array<{ name: string; reason: string | null }>;
  // True when the school's GHL contact carries a "re-enrolled" tag.
  // Surfaced as a chip next to the student name.
  re_enrolled: boolean;
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
    years: string[];
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
  // Fallback sources for allergy + special-needs text — populated by
  // the parent-portal AZ State Emergency / OTC Medication forms and the
  // yearly scripts/import-dgm-allergies.mjs run. We union these with
  // students.metadata so the roster picks up whichever source has the
  // longest meaningful text.
  hp_allergies: string | null;
  hp_medical_conditions: string | null;
  // Latest check-in notes from today (school-tz). Null if no check-in
  // happened yet OR if the check-in had no notes.
  attendance_notes_today: string | null;
  // JSON array of { name, reason } for everyone on this student's
  // pickup_restrictions list (active rows only).
  pickup_restrictions_json: Array<{ name: string; reason: string | null }> | null;
  // students.metadata.re_enrolled — true when the school's GHL contact
  // carries the "re-enrolled" tag. Set by the per-school tag sync;
  // null/false otherwise.
  re_enrolled_flag: boolean | null;
}

export async function fetcher(
  school: SchoolContext,
  config: StudentRosterConfig,
  searchParams?: WidgetSearchParams,
): Promise<StudentRosterData> {
  // Academic-year scope. Data-driven so it's multi-tenant safe: the
  // dropdown lists exactly the years this school has, and the default
  // is the latest one (URL param > widget config > latest available).
  // When a school has no enrollment years, fYear is '' → no year filter.
  const { rows: yearRows } = await query<{ academic_year: string | null }>(
    `SELECT DISTINCT e.academic_year
       FROM enrollments e JOIN students s ON s.id = e.student_id
      WHERE s.school_id = $1 AND e.academic_year IS NOT NULL`,
    [school.schoolId],
  );
  const availableYears = yearRows
    .map((r) => r.academic_year)
    .filter((y): y is string => !!y)
    .sort()
    .reverse();
  const fYear = ((searchParams ?? {}).academic_year
    ?? config.default_academic_year
    ?? availableYears[0]
    ?? '').trim();

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
       cs.curbside_slot       AS curbside_slot,
       shp.allergies          AS hp_allergies,
       shp.medical_conditions AS hp_medical_conditions,
       an.notes               AS attendance_notes_today,
       pr.restrictions_json   AS pickup_restrictions_json,
       (s.metadata->>'re_enrolled')::boolean AS re_enrolled_flag
     FROM students s
     JOIN families f ON f.id = s.family_id
     LEFT JOIN LATERAL (
       -- Prefer the enrollment for the selected academic year ($3) so a
       -- returning student surfaces the right year's row; fall back to
       -- their most recent enrollment otherwise.
       SELECT * FROM enrollments e2 WHERE e2.student_id = s.id
        ORDER BY (e2.academic_year = $3) DESC, e2.created_at DESC LIMIT 1
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
     LEFT JOIN student_health_profiles shp
       ON shp.student_id = s.id AND shp.school_id = s.school_id
     LEFT JOIN LATERAL (
       -- Most recent check-in event TODAY (school tz) with non-empty
       -- notes. Skips the auto-generated "Admin manual check-in" sentinel
       -- since that's noise — teachers care about substantive notes
       -- (mood, illness, drop-off changes).
       SELECT notes
         FROM attendance_events
        WHERE student_id = s.id
          AND school_id  = s.school_id
          AND event_type = 'check_in'
          AND notes IS NOT NULL AND btrim(notes) <> ''
          AND lower(btrim(notes)) <> 'admin manual check-in'
          AND (performed_at AT TIME ZONE $2)::date = ((now() AT TIME ZONE $2)::date)
        ORDER BY performed_at DESC LIMIT 1
     ) an ON true
     LEFT JOIN LATERAL (
       -- All active pickup restrictions for this student. Aggregated
       -- as a JSON array so the column renderer can show one chip per
       -- person without a join at render time. Empty = NULL → []
       SELECT jsonb_agg(jsonb_build_object('name', person_name, 'reason', reason)
                        ORDER BY person_name) AS restrictions_json
         FROM student_pickup_restrictions
        WHERE student_id = s.id
          AND school_id  = s.school_id
          AND active     = true
     ) pr ON true
     WHERE s.school_id = $1 AND s.status = 'active'
     ORDER BY s.first_name`,
    // Hardcoded DG timezone for now. If a future widget needs to do
    // this for another school, lift to widget config.
    [school.schoolId, 'America/Phoenix', fYear],
  );

  const all: RosterStudent[] = rows.map((r) => {
    const md = r.metadata ?? {};
    const metadataAllergy = typeof md.allergy === 'string' ? md.allergy : null;
    const metadataSpecial = typeof md.special_instructions === 'string' ? md.special_instructions : null;
    // Pick whichever source has the longest meaningful TEXT, falling
    // back from the more-authoritative metadata.allergy → health_profiles.
    // A bare "Yes" / "No" / "None" is treated as no detail.
    const allergy = bestText(metadataAllergy, r.hp_allergies);
    const special_instructions = bestText(metadataSpecial, r.hp_medical_conditions);
    const iep = typeof md.iep === 'string' ? md.iep : null;
    const five04 = typeof md.five04_plan === 'string' ? md.five04_plan : null;
    const program = typeof md.program === 'string' ? md.program : null;
    const homeroom = typeof md.homeroom === 'string' ? md.homeroom : null;
    // Year-specific tuition. metadata already holds THIS student's
    // year's value (the roster is year-filtered), so toggling the year
    // dropdown shows the right number. Prefer the descriptive
    // program_tuition string ("… - $16,250"); fall back to tuition_fee.
    const tuition = typeof md.program_tuition === 'string' ? md.program_tuition
      : (md.tuition_fee != null && md.tuition_fee !== '' ? String(md.tuition_fee) : null);
    const lunch = typeof md.organic_lunch === 'string' ? md.organic_lunch : null;
    const lunchLower = (lunch ?? '').toLowerCase();
    // "has lunch" = anything other than declined/blank. Declined values
    // start with "I decline" in DGM's GHL data, but we also tolerate a
    // bare "declined" string for robustness.
    const has_lunch = !!lunch && !lunchLower.includes('decline');
    const primary = `${r.primary_first ?? ''} ${r.primary_last ?? ''}`.trim();
    // has_allergy considers EITHER source — the legacy "Yes" metadata
    // flag (no detail) AND any non-empty health-profile allergy both
    // light up the badge, even if the rendered text is "(no detail
    // on file)". Teachers need the flag even when prose isn't there.
    const has_allergy = isMeaningfulFlag(metadataAllergy) || isMeaningfulFlag(r.hp_allergies);
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
      tuition,
      allergy,
      special_instructions,
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
      attendance_notes: r.attendance_notes_today,
      pickup_restrictions: Array.isArray(r.pickup_restrictions_json) ? r.pickup_restrictions_json : [],
      re_enrolled: r.re_enrolled_flag === true,
      search_haystack: haystack,
    };
  });

  const uniq = (vals: Iterable<string | null | undefined>): string[] =>
    [...new Set([...vals].filter((v): v is string => !!v && v.trim().length > 0))].sort();

  const options = {
    // Authoritative list of the school's years (newest first), so the
    // dropdown is stable regardless of the current selection.
    years: availableYears,
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
  const reEnrolledOnly = sp.re_enrolled_only === '1' || sp.re_enrolled_only === 'true';

  const filtered = all.filter((s) => {
    // Year scope: the enrollment join already surfaced the selected
    // year's row when the student has one; require it to match so
    // students without a same-year enrollment fall out of view.
    if (fYear && (s.academic_year ?? '') !== fYear) return false;
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
    if (reEnrolledOnly && !s.re_enrolled) return false;
    if (search && !s.search_haystack.includes(search)) return false;
    return true;
  });

  // Sort (server-side so it orders the WHOLE filtered set, not just the
  // visible page). Default: last name A–Z. Clickable headers set ?sort=&dir=.
  const sortKey = (sp.sort ?? 'last_name').trim();
  const sortDesc = sp.dir === 'desc';
  const sortText = (x: RosterStudent): string => {
    switch (sortKey) {
      case 'first_name': return (x.preferred_name || x.first_name || '');
      case 'last_name': return x.last_name || '';
      case 'program': return x.program || x.classroom_name || '';
      case 'homeroom': return x.homeroom || x.classroom_name || '';
      case 'schedule': return x.schedule || '';
      case 'status': return x.status || '';
      case 'tuition': return x.tuition || '';
      default: return x.last_name || '';
    }
  };
  filtered.sort((a, b) =>
    sortText(a).localeCompare(sortText(b), undefined, { numeric: true, sensitivity: 'base' }) * (sortDesc ? -1 : 1));

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
