// Data fetcher for the rich Enrollment Hub. Pulls the school's student
// roster (joined with most-recent enrollment + classroom + family) plus
// per-program / per-homeroom rollups, then applies the user's filter +
// search state from the URL.
//
// Caches per (school, config, searchParams) for 60s.

import { query } from '@/lib/db';
import type { SchoolContext, WidgetSearchParams } from '@/lib/widgets/types';
import type { EnrollmentHubConfig } from './config';

export interface StudentRow {
  student_id: string;
  family_id: string;
  family_display_name: string | null;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  date_of_birth: string | null;
  status: string | null;
  academic_year: string | null;
  classroom_id: string | null;
  classroom_name: string | null;
  grade_level: string | null;
  lead_teacher_name: string | null;
  schedule: string | null;
  enrolled_at: string | null;
  // From students.metadata
  program: string | null;
  homeroom: string | null;
  iep: string | null;
  five04_plan: string | null;
  allergy: string | null;
  // True when the school's GHL contact carries a "re-enrolled" tag
  // (synced into students.metadata.re_enrolled by the per-school tag
  // sync). Shrewsbury uses this to flag families committed for next year.
  re_enrolled: boolean;
  // For search
  parent_names: string;
  // Primary parent's GHL contact id — used to deep-link the "family"
  // cell directly to the CRM contact record rather than the internal
  // family-hub page. Operators bounce between the hub and the full
  // contact record constantly; without this they have to manually search
  // each time.
  primary_parent_ghl_contact_id: string | null;
  // Stringified values for any operator-configured extra GHL columns,
  // keyed by the raw metadata key. Only the configured keys are projected.
  extra: Record<string, string>;
}

export interface EnrollmentHubData {
  // All students for the school+year (pre-filter), used for breakdowns
  // and stat cards. We compute these BEFORE filters so the user can see
  // "1 of 312 shown" style messages.
  all_students: StudentRow[];

  // Filter options derived from the data
  options: {
    statuses: string[];
    programs: string[];
    homerooms: string[];
    schedules: string[];
    years: string[];
    teachers: string[];
  };

  // Filtered subset (after applying URL searchParams)
  filtered: StudentRow[];

  // Top-line counts (computed across the FILTERED set so the cards
  // respond to the operator's filters — matches bespoke behavior).
  stats: {
    enrolled: number;
    pending: number;     // accepted + enrolled_not_started
    accepted: number;
    other: number;       // inquiry/tour/application/waitlist/withdrawn/declined
    total: number;
  };

  // Breakdowns. Each row: label + counts.
  by_program: BreakdownRow[];
  by_homeroom: BreakdownRow[];
}

export interface BreakdownRow {
  label: string;
  count: number;
  enrolled: number;
  pending: number;
  accepted: number;
}

interface DbRow {
  student_id: string;
  family_id: string;
  family_display_name: string | null;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  date_of_birth: string | null;
  enrollment_status: string | null;
  academic_year: string | null;
  classroom_id: string | null;
  classroom_name: string | null;
  grade_level: string | null;
  lead_teacher_name: string | null;
  schedule: string | null;
  enrolled_at: string | null;
  metadata: Record<string, unknown> | null;
  parent_names: string;
  primary_parent_ghl_contact_id: string | null;
}

export async function fetcher(
  school: SchoolContext,
  config: EnrollmentHubConfig,
  searchParams?: WidgetSearchParams,
): Promise<EnrollmentHubData> {
  const yearFilter = (config.academic_year ?? '').trim();
  // When the school's data layer can't cleanly separate "interested"
  // from "enrolled" upstream (Wooster: only signal is a GHL tag), the
  // operator turns this on and we hard-filter at SQL level. Strictly
  // belt-and-suspenders — even if a future sync starts importing
  // inquiries, the hub stays scoped to actual students.
  const enrolledOnly = !!config.only_enrolled;
  const enrolledTag = (config.enrolled_tag ?? '').trim().toLowerCase();
  const excludedTag = (config.excluded_tag ?? '').trim().toLowerCase();

  // Build the params + the optional tag-filter clauses. Params are
  // positional ($1 = school, $2 = year if set, $3 = enrolled_tag if set,
  // $4 = excluded_tag if set). We thread the indexes manually because
  // year is optional.
  const params: unknown[] = [school.schoolId];
  let yearParamIdx: number | null = null;
  let enrolledTagParamIdx: number | null = null;
  let excludedTagParamIdx: number | null = null;
  if (yearFilter) { params.push(yearFilter); yearParamIdx = params.length; }
  if (enrolledTag) { params.push(enrolledTag); enrolledTagParamIdx = params.length; }
  if (excludedTag) { params.push(excludedTag); excludedTagParamIdx = params.length; }

  const tagInclude = enrolledTagParamIdx !== null
    ? `AND EXISTS (
         SELECT 1 FROM parents p
           JOIN ghl_contact_tags t ON t.ghl_contact_id = p.ghl_contact_id AND t.school_id = s.school_id
          WHERE p.family_id = f.id AND p.status = 'active'
            AND lower(t.tag) = $${enrolledTagParamIdx}
       )`
    : '';
  const tagExclude = excludedTagParamIdx !== null
    ? `AND NOT EXISTS (
         SELECT 1 FROM parents p
           JOIN ghl_contact_tags t ON t.ghl_contact_id = p.ghl_contact_id AND t.school_id = s.school_id
          WHERE p.family_id = f.id AND p.status = 'active'
            AND lower(t.tag) = $${excludedTagParamIdx}
       )`
    : '';

  // Big roster query. Year filter applied at SQL level; everything else
  // we apply in TS over the result so the operator can see "X of Y" counts.
  const rows = (
    await query<DbRow>(
      `SELECT
         s.id AS student_id,
         f.id AS family_id,
         f.display_name AS family_display_name,
         s.first_name, s.last_name, s.preferred_name,
         s.date_of_birth,
         e.status AS enrollment_status,
         e.academic_year,
         e.classroom_id,
         c.name AS classroom_name,
         c.grade_level,
         c.lead_teacher_name,
         e.schedule,
         e.enrolled_at,
         s.metadata,
         COALESCE(
           (SELECT string_agg(p.first_name || ' ' || p.last_name, ', ')
              FROM parents p WHERE p.family_id = f.id),
           ''
         ) AS parent_names,
         (SELECT p.ghl_contact_id
            FROM parents p
           WHERE p.family_id = f.id
           ORDER BY p.is_primary DESC NULLS LAST, p.created_at ASC
           LIMIT 1) AS primary_parent_ghl_contact_id
       FROM students s
       JOIN families f ON f.id = s.family_id
       LEFT JOIN LATERAL (
         SELECT * FROM enrollments e2
         WHERE e2.student_id = s.id ${yearParamIdx !== null ? `AND e2.academic_year = $${yearParamIdx}` : ''}
         ORDER BY e2.created_at DESC LIMIT 1
       ) e ON true
       LEFT JOIN classrooms c ON c.id = e.classroom_id
       WHERE s.school_id = $1 AND s.status = 'active'
         -- Demo / test records (metadata.is_demo = true) are excluded on
         -- every dashboard so the hubs agree (kept in the DB for testing).
         AND (s.metadata->>'is_demo') IS DISTINCT FROM 'true'
         ${enrolledOnly ? "AND e.status = 'enrolled'" : ''}
         ${tagInclude}
         ${tagExclude}
       ORDER BY s.last_name, s.first_name`,
      params,
    )
  ).rows;

  // Keys the operator asked to surface as extra columns. Projected from
  // metadata per-row below (stringified, empty-string when absent/blank).
  const extraKeys = (config.extra_columns ?? [])
    .map((c) => c.key)
    .filter((k): k is string => typeof k === 'string' && k.length > 0);

  const allStudents: StudentRow[] = rows.map((r) => {
    const md = r.metadata ?? {};
    const extra: Record<string, string> = {};
    for (const k of extraKeys) {
      extra[k] = stringifyMeta(md[k]);
    }
    return {
      student_id: r.student_id,
      family_id: r.family_id,
      family_display_name: r.family_display_name,
      first_name: r.first_name,
      last_name: r.last_name,
      preferred_name: r.preferred_name,
      date_of_birth: r.date_of_birth,
      status: r.enrollment_status,
      academic_year: r.academic_year,
      classroom_id: r.classroom_id,
      classroom_name: r.classroom_name,
      grade_level: r.grade_level,
      lead_teacher_name: r.lead_teacher_name,
      schedule: r.schedule,
      enrolled_at: r.enrolled_at,
      program: typeof md.program === 'string' ? md.program : null,
      // For schools without dedicated homerooms (Wooster) we fall back
      // to the Final-Forms-derived grade_level so the "By homeroom"
      // breakdown becomes "by grade level" — the more useful signal.
      homeroom:
        typeof md.homeroom === 'string' ? md.homeroom :
        typeof md.grade_level === 'string' ? md.grade_level :
        null,
      iep: typeof md.iep === 'string' ? md.iep : null,
      five04_plan: typeof md.five04_plan === 'string' ? md.five04_plan : null,
      allergy: typeof md.allergy === 'string' ? md.allergy : null,
      re_enrolled: md.re_enrolled === true,
      parent_names: r.parent_names ?? '',
      primary_parent_ghl_contact_id: r.primary_parent_ghl_contact_id ?? null,
      extra,
    };
  });

  // Build filter option lists (sorted unique non-empty values)
  const uniq = (vals: Array<string | null | undefined>): string[] =>
    [...new Set(vals.filter((v): v is string => !!v && v.trim().length > 0))].sort();

  const options = {
    statuses: uniq(allStudents.map((s) => s.status)),
    programs: uniq(allStudents.map((s) => s.program ?? s.classroom_name)),
    homerooms: uniq(allStudents.map((s) => s.homeroom ?? s.classroom_name)),
    schedules: uniq(allStudents.map((s) => s.schedule)),
    years: uniq(allStudents.map((s) => s.academic_year)),
    teachers: uniq(allStudents.map((s) => s.lead_teacher_name)),
  };

  // Apply URL filters
  const sp = searchParams ?? {};
  const search = (sp.q ?? '').trim().toLowerCase();
  const fStatus = (sp.status ?? '').trim();
  const fProgram = (sp.program ?? '').trim();
  const fHomeroom = (sp.homeroom ?? '').trim();
  const fSchedule = (sp.schedule ?? '').trim();
  const fYear = (sp.year ?? '').trim();
  const fTeacher = (sp.lead_teacher ?? '').trim();
  const fIep = (sp.iep ?? '').trim();          // 'yes' | 'no' | ''
  const f504 = (sp['504_plan'] ?? '').trim();
  const fAllergy = (sp.allergy ?? '').trim();
  const fReEnrolled = (sp.re_enrolled ?? '').trim();   // 'yes' | 'no' | ''

  const filtered = allStudents.filter((s) => {
    if (fStatus && (s.status ?? '') !== fStatus) return false;
    if (fProgram && (s.program ?? s.classroom_name ?? '') !== fProgram) return false;
    if (fHomeroom && (s.homeroom ?? s.classroom_name ?? '') !== fHomeroom) return false;
    if (fSchedule && (s.schedule ?? '') !== fSchedule) return false;
    if (fYear && (s.academic_year ?? '') !== fYear) return false;
    if (fTeacher && (s.lead_teacher_name ?? '') !== fTeacher) return false;
    if (fIep && yesNo(s.iep) !== fIep) return false;
    if (f504 && yesNo(s.five04_plan) !== f504) return false;
    if (fAllergy && hasAllergy(s.allergy) !== fAllergy) return false;
    if (fReEnrolled) {
      const isYes = s.re_enrolled === true;
      if (fReEnrolled === 'yes' && !isYes) return false;
      if (fReEnrolled === 'no'  &&  isYes) return false;
    }
    if (search) {
      const hay = `${s.first_name} ${s.preferred_name ?? ''} ${s.last_name} ${s.parent_names} ${s.family_display_name ?? ''}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  // Stats (across filtered set)
  let enrolled = 0, pending = 0, accepted = 0, other = 0;
  for (const s of filtered) {
    const st = s.status ?? '';
    if (st === 'enrolled') enrolled++;
    else if (st === 'accepted') accepted++;
    else if (st === 'application_submitted' || st === 'tour_scheduled') pending++;
    else other++;
  }

  // Breakdowns (across filtered set so they match the stats)
  const buildBreakdown = (groupBy: (s: StudentRow) => string | null): BreakdownRow[] => {
    const map = new Map<string, BreakdownRow>();
    for (const s of filtered) {
      const label = (groupBy(s) ?? '(none)').trim() || '(none)';
      let row = map.get(label);
      if (!row) {
        row = { label, count: 0, enrolled: 0, pending: 0, accepted: 0 };
        map.set(label, row);
      }
      row.count++;
      const st = s.status ?? '';
      if (st === 'enrolled') row.enrolled++;
      else if (st === 'accepted') row.accepted++;
      else if (st === 'application_submitted' || st === 'tour_scheduled') row.pending++;
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
  };

  return {
    all_students: allStudents,
    options,
    filtered,
    stats: {
      enrolled,
      pending,
      accepted,
      other,
      total: filtered.length,
    },
    by_program: buildBreakdown((s) => s.program ?? s.classroom_name),
    by_homeroom: buildBreakdown((s) => s.homeroom ?? s.classroom_name),
  };
}

// Render an arbitrary metadata value as a display string. Scalars pass
// through; arrays join with ", "; objects JSON-stringify; null/undefined
// become "". Keeps extra columns robust to whatever GHL field type backs them.
function stringifyMeta(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map((x) => stringifyMeta(x)).filter(Boolean).join(', ');
  try { return JSON.stringify(v); } catch { return String(v); }
}

function yesNo(raw: string | null | undefined): string {
  if (!raw) return 'no';
  const v = raw.trim().toLowerCase();
  if (!v) return 'no';
  if (v === 'no' || v === 'false' || v === '0' || v === 'n') return 'no';
  return 'yes';
}

function hasAllergy(raw: string | null | undefined): string {
  if (!raw) return 'no';
  const v = raw.trim().toLowerCase();
  if (!v || v === 'no' || v === 'none' || v === 'n/a' || v === 'na') return 'no';
  return 'yes';
}
