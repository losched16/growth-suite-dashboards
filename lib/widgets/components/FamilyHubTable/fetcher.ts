// Family Hub data fetcher. Pulls each family with its students, parents,
// most-recent-enrollment summary, and parent_payment_plan / total_tuition
// values pulled from students.metadata. Then applies URL-state filters,
// search, sort, and pagination — all server-side.

import { query } from '@/lib/db';
import type { SchoolContext, WidgetSearchParams } from '@/lib/widgets/types';
import type { FamilyHubConfig, SortKey } from './config';

// Per-family parent record exposed to the UI so the accordion can show
// both parents inline without an extra fetch.
export interface ParentRecord {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  is_primary: boolean;
  ghl_contact_id: string | null;
}

// Per-family student record (one entry per student). The `metadata` blob
// carries every snake_case GHL field captured during sync, so the accordion
// can render program-specific data (tuition_fee, daily_schedule, etc.)
// without us re-listing every key here.
export interface StudentRecord {
  id: string;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  date_of_birth: string | null;
  gender: string | null;
  enrollment_status: string;
  classroom_name: string | null;
  grade_level: string | null;
  schedule: string | null;
  enrolled_at: string | null;
  has_allergy: boolean;
  // Best free-text allergy + special-instructions across sources
  // (students.metadata first, student_health_profiles fallback).
  // Null when no source has meaningful prose — caller distinguishes
  // "no allergy" (has_allergy=false, allergy_text=null) from "flagged
  // but no detail" (has_allergy=true, allergy_text=null).
  allergy_text: string | null;
  special_instructions_text: string | null;
  metadata: Record<string, unknown>;
}

export interface FamilyRow {
  family_id: string;
  family_display_name: string | null;
  family_status: string;
  primary_parent_name: string;
  primary_parent_email: string | null;
  primary_parent_phone: string | null;
  parent_count: number;
  student_count: number;
  student_names: string;
  enrollment_summary: string;       // worst-case status across students
  enrolled_count: number;
  pending_count: number;
  accepted_count: number;
  programs: string;                  // comma-joined unique
  payment_plan: string;              // first non-empty across students
  total_tuition: number;
  has_allergy: boolean;
  search_haystack: string;           // pre-lowercased blob for substring match
  // Detail payload for the inline accordion (DG-style). Both arrays are
  // ordered: parents by is_primary DESC then created_at; students by slot.
  parents: ParentRecord[];
  students: StudentRecord[];
}

export interface FamilyHubData {
  total_families: number;            // pre-filter
  filtered: FamilyRow[];             // post-filter, post-sort
  page_rows: FamilyRow[];            // current page slice
  page: number;                      // 1-based
  per_page: number;
  page_count: number;
  options: {
    family_statuses: string[];
    enrollment_statuses: string[];
    programs: string[];
    payment_plans: string[];
    homerooms: string[];
  };
  stats: {
    families: number;
    students: number;
    enrolled: number;
    pending: number;
    accepted: number;
  };
}

interface DbRow {
  family_id: string;
  family_display_name: string | null;
  family_status: string;
  primary_first: string | null;
  primary_last: string | null;
  primary_email: string | null;
  primary_phone: string | null;
  parent_count: string;
  parent_names: string | null;
  student_count: string;
  student_names: string | null;
  enrollment_status_array: string[] | null;
  programs_array: string[] | null;
  homerooms_array: string[] | null;
  payment_plans_array: string[] | null;
  total_tuition: string | null;
  has_allergy: boolean | null;
  parents_json: ParentRecord[] | null;
  students_json: StudentRecord[] | null;
}

export async function fetcher(
  school: SchoolContext,
  config: FamilyHubConfig,
  searchParams?: WidgetSearchParams,
): Promise<FamilyHubData> {
  // Big roll-up query — one row per family.
  const { rows } = await query<DbRow>(
    `WITH per_student AS (
       SELECT
         s.id, s.family_id, s.school_id,
         s.first_name, s.last_name,
         s.metadata,
         e.status AS enrollment_status,
         c.name AS classroom_name,
         CASE
           WHEN s.metadata->>'allergy' IS NOT NULL
            AND length(s.metadata->>'allergy') > 0
            AND lower(s.metadata->>'allergy') NOT IN ('no','none','n/a','na')
           THEN true ELSE false
         END AS has_allergy,
         -- Best allergy + special-instructions text across sources.
         -- Prefer metadata when it has REAL prose (>3 chars, not yes/no
         -- filler); fall back to student_health_profiles which is
         -- populated by the parent-portal forms + the yearly DGM
         -- allergies import.
         CASE
           WHEN s.metadata->>'allergy' IS NOT NULL
            AND length(s.metadata->>'allergy') > 3
            AND lower(s.metadata->>'allergy') NOT IN ('no','none','n/a','na','yes','yes.','no.','none.')
           THEN s.metadata->>'allergy'
           WHEN shp.allergies IS NOT NULL AND length(shp.allergies) > 0
           THEN shp.allergies
           ELSE NULL
         END AS allergy_text,
         CASE
           WHEN s.metadata->>'special_instructions' IS NOT NULL
            AND length(s.metadata->>'special_instructions') > 0
           THEN s.metadata->>'special_instructions'
           WHEN shp.medical_conditions IS NOT NULL AND length(shp.medical_conditions) > 0
           THEN shp.medical_conditions
           ELSE NULL
         END AS special_instructions_text,
         COALESCE(NULLIF(s.metadata->>'tuition_fee', '')::numeric, 0)
           + COALESCE(NULLIF(s.metadata->>'extended_day_fee', '')::numeric, 0)
           + COALESCE(NULLIF(s.metadata->>'lunch_fee', '')::numeric, 0)
           AS estimated_tuition
       FROM students s
       LEFT JOIN LATERAL (
         SELECT * FROM enrollments e2
         WHERE e2.student_id = s.id
         ORDER BY e2.created_at DESC LIMIT 1
       ) e ON true
       LEFT JOIN classrooms c ON c.id = e.classroom_id
       LEFT JOIN student_health_profiles shp
         ON shp.student_id = s.id AND shp.school_id = s.school_id
       WHERE s.school_id = $1 AND s.status = 'active'
     )
     SELECT
       f.id AS family_id,
       f.display_name AS family_display_name,
       f.status AS family_status,
       (SELECT first_name FROM parents pp WHERE pp.family_id = f.id AND pp.is_primary = true AND pp.status = 'active' LIMIT 1) AS primary_first,
       (SELECT last_name FROM parents pp WHERE pp.family_id = f.id AND pp.is_primary = true AND pp.status = 'active' LIMIT 1) AS primary_last,
       (SELECT email FROM parents pp WHERE pp.family_id = f.id AND pp.is_primary = true AND pp.status = 'active' LIMIT 1) AS primary_email,
       (SELECT phone FROM parents pp WHERE pp.family_id = f.id AND pp.is_primary = true AND pp.status = 'active' LIMIT 1) AS primary_phone,
       (SELECT count(*) FROM parents pp WHERE pp.family_id = f.id AND pp.status = 'active') AS parent_count,
       (SELECT string_agg(pp.first_name || ' ' || pp.last_name, ', ')
          FROM parents pp WHERE pp.family_id = f.id AND pp.status = 'active') AS parent_names,
       (SELECT count(*) FROM per_student ps WHERE ps.family_id = f.id) AS student_count,
       (SELECT string_agg(ps.first_name || ' ' || ps.last_name, ', ')
          FROM per_student ps WHERE ps.family_id = f.id) AS student_names,
       (SELECT array_agg(DISTINCT ps.enrollment_status) FILTER (WHERE ps.enrollment_status IS NOT NULL)
          FROM per_student ps WHERE ps.family_id = f.id) AS enrollment_status_array,
       (SELECT array_agg(DISTINCT ps.metadata->>'program') FILTER (WHERE ps.metadata->>'program' IS NOT NULL AND length(ps.metadata->>'program') > 0)
          FROM per_student ps WHERE ps.family_id = f.id) AS programs_array,
       (SELECT array_agg(DISTINCT ps.classroom_name) FILTER (WHERE ps.classroom_name IS NOT NULL)
          FROM per_student ps WHERE ps.family_id = f.id) AS homerooms_array,
       (SELECT array_agg(DISTINCT ps.metadata->>'payment_plan') FILTER (WHERE ps.metadata->>'payment_plan' IS NOT NULL AND length(ps.metadata->>'payment_plan') > 0)
          FROM per_student ps WHERE ps.family_id = f.id) AS payment_plans_array,
       (SELECT sum(ps.estimated_tuition) FROM per_student ps WHERE ps.family_id = f.id) AS total_tuition,
       (SELECT bool_or(ps.has_allergy) FROM per_student ps WHERE ps.family_id = f.id) AS has_allergy,
       -- Per-family parent payload for the accordion. Primary first, then by created_at.
       (SELECT json_agg(
            jsonb_build_object(
              'id', pp.id,
              'first_name', COALESCE(pp.first_name, ''),
              'last_name', COALESCE(pp.last_name, ''),
              'email', pp.email,
              'phone', pp.phone,
              'is_primary', pp.is_primary,
              'ghl_contact_id', pp.ghl_contact_id
            )
            ORDER BY pp.is_primary DESC, pp.created_at
          )
          FROM parents pp
          WHERE pp.family_id = f.id AND pp.status = 'active') AS parents_json,
       -- Per-family student payload for the accordion. Ordered by slot then created_at.
       (SELECT json_agg(
            jsonb_build_object(
              'id', ps.id,
              'first_name', COALESCE(ps.first_name, ''),
              'last_name', COALESCE(ps.last_name, ''),
              'preferred_name', ps.metadata->>'preferred_name',
              'date_of_birth', ps.metadata->>'birth_date',
              'gender', ps.metadata->>'gender',
              'enrollment_status', COALESCE(ps.enrollment_status, ''),
              'classroom_name', ps.classroom_name,
              'grade_level', ps.metadata->>'grade_level',
              'schedule', ps.metadata->>'daily_schedule',
              'enrolled_at', ps.metadata->>'current_year_enrollment_start_date',
              'has_allergy', ps.has_allergy,
              'allergy_text', ps.allergy_text,
              'special_instructions_text', ps.special_instructions_text,
              'metadata', ps.metadata
            )
            ORDER BY COALESCE((ps.metadata->>'ghl_slot')::int, 99), ps.id
          )
          FROM per_student ps
          WHERE ps.family_id = f.id) AS students_json
     FROM families f
     WHERE f.school_id = $1
     ORDER BY f.display_name`,
    [school.schoolId],
  );

  const allFamilies: FamilyRow[] = rows.map((r) => {
    const enrStatuses = r.enrollment_status_array ?? [];
    const enrolled = enrStatuses.includes('enrolled') ? 1 : 0;
    const accepted = enrStatuses.includes('accepted') ? 1 : 0;
    const pending = (enrStatuses.includes('application_submitted') || enrStatuses.includes('tour_scheduled')) ? 1 : 0;
    // Worst-case roll-up label
    const summary = pickWorstStatus(enrStatuses);

    const primaryName = `${r.primary_first ?? ''} ${r.primary_last ?? ''}`.trim() || '(unnamed)';
    const studentNames = r.student_names ?? '';
    const programs = (r.programs_array ?? []).filter(Boolean).sort().join(', ');
    const paymentPlan = (r.payment_plans_array ?? []).filter(Boolean)[0] ?? '';

    const haystack = [
      primaryName,
      r.parent_names ?? '',
      r.primary_email ?? '',
      studentNames,
      r.family_display_name ?? '',
    ].join(' ').toLowerCase();

    return {
      family_id: r.family_id,
      family_display_name: r.family_display_name,
      family_status: r.family_status,
      primary_parent_name: primaryName,
      primary_parent_email: r.primary_email,
      primary_parent_phone: r.primary_phone,
      parent_count: Number(r.parent_count),
      student_count: Number(r.student_count),
      student_names: studentNames,
      enrollment_summary: summary,
      enrolled_count: enrolled,
      pending_count: pending,
      accepted_count: accepted,
      programs,
      payment_plan: paymentPlan,
      total_tuition: Number(r.total_tuition ?? 0),
      has_allergy: !!r.has_allergy,
      search_haystack: haystack,
      parents: r.parents_json ?? [],
      students: r.students_json ?? [],
    };
  });

  // Build filter option lists
  const uniq = (vals: Iterable<string | null | undefined>): string[] =>
    [...new Set([...vals].filter((v): v is string => !!v && v.trim().length > 0))].sort();

  const options = {
    family_statuses: uniq(allFamilies.map((f) => f.family_status)),
    enrollment_statuses: uniq(allFamilies.flatMap((f) => f.enrollment_summary ? [f.enrollment_summary] : [])),
    programs: uniq(allFamilies.flatMap((f) => f.programs.split(', ').filter(Boolean))),
    payment_plans: uniq(allFamilies.map((f) => f.payment_plan)),
    homerooms: uniq(rows.flatMap((r) => r.homerooms_array ?? [])),
  };

  // Apply filters from URL
  const sp = searchParams ?? {};
  const search = (sp.q ?? '').trim().toLowerCase();
  const fStatus = (sp.family_status ?? '').trim();
  const fEnr = (sp.enrollment_status ?? '').trim();
  const fProg = (sp.program ?? '').trim();
  const fPlan = (sp.payment_plan ?? '').trim();
  const fHome = (sp.homeroom ?? '').trim();
  const fAllergy = (sp.has_allergy ?? '').trim();

  let filtered = allFamilies.filter((f) => {
    if (fStatus && f.family_status !== fStatus) return false;
    if (fEnr && f.enrollment_summary !== fEnr) return false;
    if (fProg && !f.programs.split(', ').includes(fProg)) return false;
    if (fPlan && f.payment_plan !== fPlan) return false;
    if (fHome) {
      // homeroom filter — needs to look back at the per-row homerooms_array
      const idx = allFamilies.indexOf(f);
      const homerooms = rows[idx]?.homerooms_array ?? [];
      if (!homerooms.includes(fHome)) return false;
    }
    if (fAllergy === 'yes' && !f.has_allergy) return false;
    if (fAllergy === 'no' && f.has_allergy) return false;
    if (search && !f.search_haystack.includes(search)) return false;
    return true;
  });

  // Sort
  const sortKey = (sp.sort ?? 'family') as SortKey;
  const sortDir = sp.dir === 'desc' ? 'desc' : 'asc';
  filtered = sortRows(filtered, sortKey, sortDir);

  // Stats roll-up across filtered
  const stats = {
    families: filtered.length,
    students: filtered.reduce((s, f) => s + f.student_count, 0),
    enrolled: filtered.reduce((s, f) => s + f.enrolled_count, 0),
    pending: filtered.reduce((s, f) => s + f.pending_count, 0),
    accepted: filtered.reduce((s, f) => s + f.accepted_count, 0),
  };

  // Pagination
  const perPage = Math.max(10, Math.min(500, Number(sp.per_page) || config.page_size || 50));
  const page = Math.max(1, Number(sp.page) || 1);
  const pageCount = Math.max(1, Math.ceil(filtered.length / perPage));
  const safePage = Math.min(page, pageCount);
  const start = (safePage - 1) * perPage;
  const pageRows = filtered.slice(start, start + perPage);

  return {
    total_families: allFamilies.length,
    filtered,
    page_rows: pageRows,
    page: safePage,
    per_page: perPage,
    page_count: pageCount,
    options,
    stats,
  };
}

const STATUS_RANK: Record<string, number> = {
  inquiry: 0,
  tour_scheduled: 1,
  application_submitted: 2,
  accepted: 3,
  enrolled: 4,
  waitlisted: -1,
  withdrawn: -2,
  declined: -3,
};

function pickWorstStatus(statuses: string[]): string {
  if (statuses.length === 0) return '';
  // "Worst" = most-progressed (highest rank). Matches DG bespoke logic.
  let best = statuses[0], rank = STATUS_RANK[best] ?? -99;
  for (const s of statuses) {
    const r = STATUS_RANK[s] ?? -99;
    if (r > rank) { best = s; rank = r; }
  }
  return best;
}

function sortRows(rows: FamilyRow[], key: SortKey, dir: 'asc' | 'desc'): FamilyRow[] {
  const cmp = (a: FamilyRow, b: FamilyRow): number => {
    let x: string | number, y: string | number;
    switch (key) {
      case 'family':
        x = (a.family_display_name ?? a.primary_parent_name).toLowerCase();
        y = (b.family_display_name ?? b.primary_parent_name).toLowerCase();
        break;
      case 'students': x = a.student_count; y = b.student_count; break;
      case 'enrollment':
        x = STATUS_RANK[a.enrollment_summary] ?? -99;
        y = STATUS_RANK[b.enrollment_summary] ?? -99;
        break;
      case 'payment_plan': x = a.payment_plan; y = b.payment_plan; break;
      case 'total_tuition': x = a.total_tuition; y = b.total_tuition; break;
      case 'active':
        x = a.family_status === 'active' ? 1 : 0;
        y = b.family_status === 'active' ? 1 : 0;
        break;
    }
    if (x < y) return dir === 'asc' ? -1 : 1;
    if (x > y) return dir === 'asc' ? 1 : -1;
    return 0;
  };
  return [...rows].sort(cmp);
}
