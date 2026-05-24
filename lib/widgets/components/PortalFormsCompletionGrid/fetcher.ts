// Data fetcher for PortalFormsCompletionGrid.
//
// Returns rows of (student × form-completion). Per-student forms get one
// column per student; per-family forms get a single column per family
// (replicated on each row of that family for display simplicity).

import { query } from '@/lib/db';
import type { SchoolContext } from '@/lib/widgets/types';
import type { PortalFormsCompletionGridConfig } from './config';

export interface CompletionFormCol {
  id: string;
  slug: string;
  display_name: string;
  category: string | null;
  per_student: boolean;
  required_for: string | null;
}

export interface CompletionRow {
  student_id: string;
  family_id: string;
  family_label: string;
  student_label: string;
  enrollment_status: string | null;
  // For each form (key = def.id): completion status
  cells: Record<string, { status: string; submitted_at: string | null; submission_id: string | null }>;
}

export interface PortalFormsCompletionGridData {
  forms: CompletionFormCol[];
  rows: CompletionRow[];
  totals: {
    students: number;
    fully_complete_students: number;
    pct: number;
    total_submissions: number;
  };
}

export async function fetcher(
  school: SchoolContext,
  config: PortalFormsCompletionGridConfig,
): Promise<PortalFormsCompletionGridData> {
  // 1. Form definitions
  const formsRes = await query<CompletionFormCol & { is_active: boolean }>(
    `SELECT id, slug, display_name, category, per_student, required_for, is_active
     FROM portal_form_definitions
     WHERE school_id = $1
       AND ($2::boolean = false OR is_active = true)
     ORDER BY
       CASE category
         WHEN 'registration' THEN 1
         WHEN 'medical' THEN 2
         WHEN 'permission' THEN 3
         WHEN 'release' THEN 4
         WHEN 'legal' THEN 5
         WHEN 'trip' THEN 6
         ELSE 9
       END,
       display_name`,
    [school.schoolId, config.only_active],
  );
  const forms: CompletionFormCol[] = formsRes.rows
    .filter((f) => config.categories.length === 0 || (f.category && config.categories.includes(f.category)));

  // 2. Students (one per row). Filter by enrollment status if requested.
  const studentsRes = await query<{
    student_id: string;
    family_id: string;
    family_label: string;
    student_label: string;
    enrollment_status: string | null;
  }>(
    `SELECT
       s.id AS student_id,
       s.family_id,
       COALESCE(NULLIF(f.display_name, ''),
                CONCAT_WS(' ', p_lead.first_name, p_lead.last_name)) AS family_label,
       CONCAT_WS(' ', COALESCE(NULLIF(s.preferred_name, ''), s.first_name), s.last_name) AS student_label,
       e.status AS enrollment_status
     FROM students s
     JOIN families f ON f.id = s.family_id
     LEFT JOIN LATERAL (
       SELECT first_name, last_name FROM parents
       WHERE family_id = s.family_id AND is_primary = true LIMIT 1
     ) p_lead ON true
     LEFT JOIN LATERAL (
       SELECT status FROM enrollments
       WHERE student_id = s.id ORDER BY created_at DESC LIMIT 1
     ) e ON true
     WHERE s.school_id = $1 AND s.status = 'active'
     ORDER BY family_label, student_label`,
    [school.schoolId],
  );
  const rows: CompletionRow[] = studentsRes.rows
    .filter((r) => {
      if (config.status_filter === 'all') return true;
      return r.enrollment_status === 'enrolled';
    })
    .map((r) => ({
      student_id: r.student_id,
      family_id: r.family_id,
      family_label: r.family_label || '(unnamed family)',
      student_label: r.student_label,
      enrollment_status: r.enrollment_status,
      cells: {},
    }));

  if (forms.length === 0 || rows.length === 0) {
    return {
      forms,
      rows,
      totals: { students: rows.length, fully_complete_students: 0, pct: 0, total_submissions: 0 },
    };
  }

  // 3. Submissions for this school/year, only for the form defs we care about.
  const subsRes = await query<{
    id: string;
    form_definition_id: string;
    family_id: string;
    student_id: string | null;
    status: string;
    submitted_at: string;
  }>(
    `SELECT id, form_definition_id, family_id, student_id, status, submitted_at
     FROM portal_form_submissions
     WHERE school_id = $1
       AND academic_year = $2
       AND status IN ('submitted', 'paid', 'pending_payment')
       AND form_definition_id = ANY($3::uuid[])`,
    [school.schoolId, config.academic_year, forms.map((f) => f.id)],
  );

  // Index by (form_id, student_id-or-null)
  const perStudent = new Map<string, { id: string; submitted_at: string; status: string }>();
  const perFamily = new Map<string, { id: string; submitted_at: string; status: string }>();
  for (const s of subsRes.rows) {
    if (s.student_id) {
      perStudent.set(`${s.form_definition_id}::${s.student_id}`, {
        id: s.id, submitted_at: s.submitted_at, status: s.status,
      });
    } else {
      perFamily.set(`${s.form_definition_id}::${s.family_id}`, {
        id: s.id, submitted_at: s.submitted_at, status: s.status,
      });
    }
  }

  // 4. Fill cells
  let fullyComplete = 0;
  for (const row of rows) {
    let all = true;
    for (const f of forms) {
      const key = f.per_student
        ? `${f.id}::${row.student_id}`
        : `${f.id}::${row.family_id}`;
      const hit = (f.per_student ? perStudent : perFamily).get(key);
      if (hit) {
        row.cells[f.id] = {
          status: hit.status, submitted_at: hit.submitted_at, submission_id: hit.id,
        };
      } else {
        row.cells[f.id] = { status: 'missing', submitted_at: null, submission_id: null };
        all = false;
      }
    }
    if (all) fullyComplete++;
  }

  return {
    forms,
    rows,
    totals: {
      students: rows.length,
      fully_complete_students: fullyComplete,
      pct: rows.length ? Math.round((fullyComplete / rows.length) * 100) : 0,
      total_submissions: subsRes.rows.length,
    },
  };
}
