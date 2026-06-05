import { query } from '@/lib/db';
import type { SchoolContext, WidgetSearchParams } from '@/lib/widgets/types';
import type { FinancialAidQueueConfig } from './config';

export interface FaFileRow {
  id: string;
  document_type: string | null;
  display_name: string;
  size_bytes: number;
  uploaded_at: string;
}

export interface FaStudentRow {
  id: string;                        // fa_application_students.id
  student_id: string;
  first_name: string;
  last_name: string;
  grade: string | null;
  current_tuition: number;
  requested_aid: number;
  recommended_award: number | null;
  award_note: string | null;
}

export interface FaApplicationRow {
  id: string;
  family_id: string;
  family_display_name: string;
  parent_name: string;
  parent_email: string | null;
  parent_phone: string | null;
  parent_ghl_contact_id: string | null;
  academic_year: string;
  status: string;
  household_size: number | null;
  total_annual_income: number;
  assets_value: number;
  // Family totals (sums across students)
  total_current_tuition: number;
  total_requested: number;
  total_recommended: number;        // only set once student awards exist
  special_circumstances: string | null;
  parent_notes: string | null;
  decision_note: string | null;
  decided_at: string | null;
  decided_by: string | null;
  submitted_at: string | null;
  updated_at: string;
  students: FaStudentRow[];
  files: FaFileRow[];
  // Cached Claude analysis (null if never generated for this app).
  ai_analysis: Record<string, unknown> | null;
  ai_analyzed_at: string | null;
  ai_analysis_model: string | null;
}

export interface FinancialAidQueueData {
  stats: {
    submitted: number;
    reviewing: number;
    decided: number;
    withdrawn: number;
    total: number;
    total_requested: number;
    total_recommended: number;
  };
  rows: FaApplicationRow[];
  options: {
    academic_years: string[];
  };
}

interface DbRow {
  id: string;
  family_id: string;
  family_display_name: string | null;
  parent_first: string | null;
  parent_last: string | null;
  parent_email: string | null;
  parent_phone: string | null;
  parent_ghl_contact_id: string | null;
  academic_year: string;
  status: string;
  household_size: number | null;
  total_annual_income: string | null;
  assets_value: string | null;
  total_current_tuition: string | null;
  total_requested: string | null;
  total_recommended: string | null;
  special_circumstances: string | null;
  parent_notes: string | null;
  decision_note: string | null;
  decided_at: string | null;
  decided_by: string | null;
  submitted_at: string | null;
  updated_at: string;
  students_json: FaStudentRow[] | null;
  files_json: FaFileRow[] | null;
  ai_analysis: Record<string, unknown> | null;
  ai_analyzed_at: string | null;
  ai_analysis_model: string | null;
}

export async function fetcher(
  school: SchoolContext,
  config: FinancialAidQueueConfig,
  searchParams?: WidgetSearchParams,
): Promise<FinancialAidQueueData> {
  const sp = searchParams ?? {};
  const yearFilter = (sp.year ?? '').trim();
  const statusFilter = (sp.status ?? '').trim();
  const search = (sp.q ?? '').trim().toLowerCase();

  const { rows } = await query<DbRow>(
    `WITH student_aggs AS (
       SELECT
         cs.application_id,
         json_agg(
           json_build_object(
             'id', cs.id,
             'student_id', cs.student_id,
             'first_name', COALESCE(s.first_name, ''),
             'last_name', COALESCE(s.last_name, ''),
             'grade', s.metadata->>'grade_level',
             'current_tuition', COALESCE(cs.current_tuition, 0),
             'requested_aid', COALESCE(cs.requested_aid, 0),
             'recommended_award', cs.recommended_award,
             'award_note', cs.award_note
           ) ORDER BY s.first_name
         ) AS students,
         SUM(COALESCE(cs.current_tuition, 0))::numeric AS total_current_tuition,
         SUM(COALESCE(cs.requested_aid, 0))::numeric AS total_requested,
         SUM(cs.recommended_award)::numeric AS total_recommended
       FROM fa_application_students cs
       LEFT JOIN students s ON s.id = cs.student_id
       GROUP BY cs.application_id
     ),
     file_aggs AS (
       SELECT
         application_id,
         json_agg(
           json_build_object(
             'id', id,
             'document_type', document_type,
             'display_name', display_name,
             'size_bytes', size_bytes,
             'uploaded_at', uploaded_at
           ) ORDER BY uploaded_at DESC
         ) AS files
       FROM fa_application_files
       WHERE school_id = $1
       GROUP BY application_id
     )
     SELECT
       a.id,
       a.family_id,
       f.display_name AS family_display_name,
       p.first_name AS parent_first,
       p.last_name AS parent_last,
       p.email AS parent_email,
       p.phone AS parent_phone,
       p.ghl_contact_id AS parent_ghl_contact_id,
       a.academic_year,
       a.status,
       a.household_size,
       a.total_annual_income,
       a.assets_value,
       COALESCE(sa.total_current_tuition, a.current_tuition_owed) AS total_current_tuition,
       COALESCE(sa.total_requested, a.requested_aid) AS total_requested,
       sa.total_recommended,
       a.special_circumstances,
       a.parent_notes,
       a.decision_note,
       a.decided_at,
       a.decided_by,
       a.submitted_at,
       a.updated_at,
       sa.students AS students_json,
       fa.files AS files_json,
       a.ai_analysis, a.ai_analyzed_at::text, a.ai_analysis_model
     FROM fa_applications a
     JOIN families f ON f.id = a.family_id
     LEFT JOIN LATERAL (
       SELECT first_name, last_name, email, phone, ghl_contact_id
       FROM parents pp
       WHERE pp.family_id = a.family_id AND pp.is_primary = true AND pp.status = 'active'
       ORDER BY pp.created_at LIMIT 1
     ) p ON true
     LEFT JOIN student_aggs sa ON sa.application_id = a.id
     LEFT JOIN file_aggs fa ON fa.application_id = a.id
     WHERE a.school_id = $1 AND a.status <> 'draft'
     ORDER BY a.submitted_at DESC NULLS LAST, a.updated_at DESC`,
    [school.schoolId],
  );

  const all: FaApplicationRow[] = rows.map((r) => ({
    id: r.id,
    family_id: r.family_id,
    family_display_name: r.family_display_name ?? '',
    parent_name: [r.parent_first, r.parent_last].filter(Boolean).join(' ').trim() || '(no name)',
    parent_email: r.parent_email,
    parent_phone: r.parent_phone,
    parent_ghl_contact_id: r.parent_ghl_contact_id,
    academic_year: r.academic_year,
    status: r.status,
    household_size: r.household_size,
    total_annual_income: Number(r.total_annual_income ?? 0),
    assets_value: Number(r.assets_value ?? 0),
    total_current_tuition: Number(r.total_current_tuition ?? 0),
    total_requested: Number(r.total_requested ?? 0),
    total_recommended: r.total_recommended === null ? 0 : Number(r.total_recommended),
    special_circumstances: r.special_circumstances,
    parent_notes: r.parent_notes,
    decision_note: r.decision_note,
    decided_at: r.decided_at,
    decided_by: r.decided_by,
    submitted_at: r.submitted_at,
    updated_at: r.updated_at,
    students: (r.students_json ?? []).map((s) => ({
      ...s,
      current_tuition: Number(s.current_tuition ?? 0),
      requested_aid: Number(s.requested_aid ?? 0),
      recommended_award: s.recommended_award === null ? null : Number(s.recommended_award),
    })),
    files: r.files_json ?? [],
    ai_analysis: r.ai_analysis,
    ai_analyzed_at: r.ai_analyzed_at,
    ai_analysis_model: r.ai_analysis_model,
  }));

  const years = Array.from(new Set(all.map((a) => a.academic_year))).sort().reverse();

  const filtered = all.filter((a) => {
    if (yearFilter && a.academic_year !== yearFilter) return false;
    if (statusFilter && a.status !== statusFilter) return false;
    if (search) {
      const studentNames = a.students.map((s) => `${s.first_name} ${s.last_name}`).join(' ');
      const hay = (
        a.family_display_name + ' ' +
        studentNames + ' ' +
        a.parent_name + ' ' + (a.parent_email ?? '')
      ).toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  void config;

  const stats = {
    submitted: filtered.filter((a) => a.status === 'submitted').length,
    reviewing: filtered.filter((a) => a.status === 'reviewing').length,
    decided: filtered.filter((a) => a.status === 'decided').length,
    withdrawn: filtered.filter((a) => a.status === 'withdrawn').length,
    total: filtered.length,
    total_requested: filtered.reduce((s, a) => s + a.total_requested, 0),
    total_recommended: filtered.reduce((s, a) => s + a.total_recommended, 0),
  };

  return {
    stats,
    rows: filtered,
    options: { academic_years: years },
  };
}
