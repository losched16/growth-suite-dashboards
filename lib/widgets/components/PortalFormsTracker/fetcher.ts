// PortalFormsTracker data fetcher. Builds the family-row grid by:
//   1. Loading active parent-portal forms for the school
//   2. Walking every active family with at least one currently-enrolled
//      student
//   3. For each (family, form), computing the per-student chip status
//      from portal_form_submissions

import { query } from '@/lib/db';
import type { SchoolContext, WidgetSearchParams } from '@/lib/widgets/types';
import type { PortalFormsTrackerConfig } from './config';

export interface FormDef {
  id: string;
  slug: string;
  display_name: string;
  category: string | null;
  per_student: boolean;
  position: number;
}

export interface StudentChip {
  student_id: string;
  slot: number;          // 1-indexed kid position within the family
  display_name: string;
  applies: boolean;      // does this form apply to this student?
  complete: boolean;     // has a submission landed for this kid?
  submission_id: string | null;
  submitted_at: string | null;
}

export interface FamilyRow {
  family_id: string;
  family_display_name: string;
  primary_parent_name: string;
  primary_parent_email: string | null;
  primary_parent_ghl_contact_id: string | null;
  enrolled_student_count: number;
  enrolled_students: Array<{
    student_id: string;
    slot: number;
    display_name: string;
  }>;
  cells: Record<string, StudentChip[]>;
  applicable_count: number;
  complete_count: number;
  pct: number;
  status: 'complete' | 'in_progress' | 'not_started';
}

export interface PortalFormsTrackerData {
  forms: FormDef[];
  rows: FamilyRow[];
  stats: {
    // Family-level counts kept for context / sub-labels.
    enrolled_families: number;
    families_fully_complete: number;
    families_in_progress: number;
    families_not_started: number;
    // Student-level counts — primary tracking unit. A family with 2 kids
    // counts as 2 here, and a student is "fully complete" when every
    // applicable per-student form for them AND every family-level form
    // for their family has been submitted.
    total_students: number;
    students_fully_complete: number;
    students_in_progress: number;
    students_not_started: number;
  };
  last_loaded_at: string;
}

interface DbForm {
  id: string;
  slug: string;
  display_name: string;
  category: string | null;
  per_student: boolean;
  position: number;
}

interface DbStudent {
  student_id: string;
  family_id: string;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
}

interface DbFamilyMeta {
  family_id: string;
  family_display_name: string | null;
  primary_first: string | null;
  primary_last: string | null;
  primary_email: string | null;
  primary_ghl_contact_id: string | null;
}

interface DbSubmissionLite {
  form_definition_id: string;
  family_id: string | null;
  student_id: string | null;
  submission_id: string;
  submitted_at: string;
}

function studentLabel(s: DbStudent): string {
  const first = s.preferred_name?.trim() || s.first_name;
  return `${first} ${s.last_name}`.trim();
}

export async function fetcher(
  school: SchoolContext,
  config: PortalFormsTrackerConfig,
  _sp?: WidgetSearchParams,
): Promise<PortalFormsTrackerData> {
  void _sp;
  const categories = Array.isArray(config.categories) ? config.categories : [];

  // 1. Active parent-portal forms
  const { rows: forms } = await query<DbForm>(
    `SELECT id, slug, display_name, category, per_student,
            COALESCE((field_schema->'sort')::int, 0) AS position
       FROM portal_form_definitions
      WHERE school_id = $1
        AND is_active = true
        AND COALESCE(audience, 'parents') = 'parents'
        AND ($2::text[] = ARRAY[]::text[] OR category = ANY($2::text[]))
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
    [school.schoolId, categories],
  );

  // 2. Enrolled families + students
  const { rows: students } = await query<DbStudent>(
    `SELECT s.id AS student_id, s.family_id,
            s.first_name, s.last_name, s.preferred_name
       FROM students s
      WHERE s.school_id = $1 AND s.status = 'active'
      ORDER BY s.family_id, s.first_name`,
    [school.schoolId],
  );

  // 3. Family metadata + primary parent
  const { rows: famMeta } = await query<DbFamilyMeta>(
    `SELECT f.id AS family_id,
            f.display_name AS family_display_name,
            (SELECT first_name FROM parents p WHERE p.family_id = f.id AND p.is_primary = true LIMIT 1) AS primary_first,
            (SELECT last_name FROM parents p WHERE p.family_id = f.id AND p.is_primary = true LIMIT 1) AS primary_last,
            (SELECT email FROM parents p WHERE p.family_id = f.id AND p.is_primary = true LIMIT 1) AS primary_email,
            (SELECT ghl_contact_id FROM parents p WHERE p.family_id = f.id AND p.is_primary = true LIMIT 1) AS primary_ghl_contact_id
       FROM families f
      WHERE f.school_id = $1
        AND EXISTS (
          SELECT 1 FROM students s
           WHERE s.family_id = f.id AND s.school_id = $1 AND s.status = 'active'
        )`,
    [school.schoolId],
  );

  // 4. All submissions for these forms (one query, then bucketed in code)
  const formIds = forms.map((f) => f.id);
  const familyIds = famMeta.map((f) => f.family_id);
  const { rows: subs } = await query<DbSubmissionLite>(
    formIds.length === 0 || familyIds.length === 0
      ? `SELECT NULL::uuid AS form_definition_id, NULL::uuid AS family_id,
                NULL::uuid AS student_id, NULL::uuid AS submission_id,
                NULL::text AS submitted_at WHERE false`
      : `SELECT s.form_definition_id, s.family_id, s.student_id,
                s.id AS submission_id,
                to_char(s.submitted_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS submitted_at
           FROM portal_form_submissions s
          WHERE s.school_id = $1
            AND COALESCE(s.is_test, false) = false
            -- Count anything that's been "filled out" — including legacy
            -- imports (status='legacy_imported') from the CSV + GHL
            -- backfill. Without legacy_imported, Wooster's historical
            -- data would appear as un-submitted in the tracker.
            AND s.status IN ('submitted', 'paid', 'pending_payment', 'legacy_imported')
            AND s.form_definition_id = ANY($2::uuid[])
            AND (
              s.family_id = ANY($3::uuid[])
              OR s.student_id IN (
                SELECT id FROM students WHERE family_id = ANY($3::uuid[])
              )
            )
          ORDER BY s.submitted_at DESC`,
    formIds.length === 0 || familyIds.length === 0 ? [] : [school.schoolId, formIds, familyIds],
  );

  // ── Bucket students by family ────────────────────────────────────
  const studentsByFamily = new Map<string, DbStudent[]>();
  for (const s of students) {
    if (!studentsByFamily.has(s.family_id)) studentsByFamily.set(s.family_id, []);
    studentsByFamily.get(s.family_id)!.push(s);
  }

  // ── Submission lookup tables ────────────────────────────────────
  // For per_student forms: key = `${formId}|${studentId}` → submission
  // For family-level forms: key = `${formId}|${familyId}` → submission
  type SubRef = { submission_id: string; submitted_at: string };
  const perStudent = new Map<string, SubRef>();
  const perFamily = new Map<string, SubRef>();
  for (const s of subs) {
    if (!s.submission_id) continue;
    if (s.student_id) {
      const k = `${s.form_definition_id}|${s.student_id}`;
      // Newest first ordering → only keep the first one we see.
      if (!perStudent.has(k)) perStudent.set(k, { submission_id: s.submission_id, submitted_at: s.submitted_at });
    } else if (s.family_id) {
      const k = `${s.form_definition_id}|${s.family_id}`;
      if (!perFamily.has(k)) perFamily.set(k, { submission_id: s.submission_id, submitted_at: s.submitted_at });
    }
  }

  // ── Build family rows ───────────────────────────────────────────
  const rows: FamilyRow[] = [];
  const formsForBuild: FormDef[] = forms.map((f) => ({
    id: f.id,
    slug: f.slug,
    display_name: f.display_name,
    category: f.category,
    per_student: f.per_student,
    position: f.position,
  }));

  for (const fam of famMeta) {
    const familyStudents = studentsByFamily.get(fam.family_id) ?? [];
    const enrolledStudents = familyStudents.map((s, i) => ({
      student_id: s.student_id,
      slot: i + 1,
      display_name: studentLabel(s),
    }));

    const cells: Record<string, StudentChip[]> = {};
    let applicableCount = 0;
    let completeCount = 0;
    for (const form of formsForBuild) {
      if (form.per_student) {
        // One chip per student in the family. All of them are "applicable"
        // by default; per-school applicability rules would land here later.
        const list: StudentChip[] = familyStudents.map((s, i) => {
          const sub = perStudent.get(`${form.id}|${s.student_id}`);
          const complete = !!sub;
          applicableCount++;
          if (complete) completeCount++;
          return {
            student_id: s.student_id,
            slot: i + 1,
            display_name: studentLabel(s),
            applies: true,
            complete,
            submission_id: sub?.submission_id ?? null,
            submitted_at: sub?.submitted_at ?? null,
          };
        });
        cells[form.id] = list;
      } else {
        // Family-level form → one cell for the whole family. Render as a
        // single "slot 0" chip so the component treats it uniformly.
        const sub = perFamily.get(`${form.id}|${fam.family_id}`);
        const complete = !!sub;
        applicableCount++;
        if (complete) completeCount++;
        cells[form.id] = [{
          student_id: fam.family_id,
          slot: 0,
          display_name: fam.family_display_name ?? 'Family',
          applies: true,
          complete,
          submission_id: sub?.submission_id ?? null,
          submitted_at: sub?.submitted_at ?? null,
        }];
      }
    }

    const pct = applicableCount === 0 ? 0 : Math.round((completeCount / applicableCount) * 100);
    const status: FamilyRow['status'] =
      completeCount === 0 ? 'not_started' :
      completeCount === applicableCount ? 'complete' :
      'in_progress';

    rows.push({
      family_id: fam.family_id,
      family_display_name: fam.family_display_name || `${fam.primary_last ?? 'Family'} Family`,
      primary_parent_name: [fam.primary_first, fam.primary_last].filter(Boolean).join(' ') || '(no primary parent)',
      primary_parent_email: fam.primary_email,
      primary_parent_ghl_contact_id: fam.primary_ghl_contact_id,
      enrolled_student_count: familyStudents.length,
      enrolled_students: enrolledStudents,
      cells,
      applicable_count: applicableCount,
      complete_count: completeCount,
      pct,
      status,
    });
  }

  // Student-based stats. For each enrolled student we sum:
  //   applicable = (# per-student forms that apply to them)
  //              + (# family-level forms applicable to their family)
  //   complete   = (# per-student forms they've submitted)
  //              + (# family-level forms their family has submitted)
  //
  // Joe's framing: a family with 2 enrolled kids counts as 2 in the
  // stats strip, not 1. One kid done + one not = 1 fully complete +
  // 1 not started (or in progress, depending on family-level forms).
  let studentsFullyComplete = 0;
  let studentsInProgress = 0;
  let studentsNotStarted = 0;
  for (const r of rows) {
    // Family-level totals are constant across all kids in the family.
    let famApplicable = 0;
    let famComplete = 0;
    for (const form of formsForBuild) {
      if (form.per_student) continue;
      const cell = r.cells[form.id]?.[0];
      if (!cell?.applies) continue;
      famApplicable++;
      if (cell.complete) famComplete++;
    }

    for (const student of r.enrolled_students) {
      let applicable = famApplicable;
      let complete = famComplete;
      for (const form of formsForBuild) {
        if (!form.per_student) continue;
        const cell = (r.cells[form.id] ?? []).find((c) => c.student_id === student.student_id);
        if (!cell?.applies) continue;
        applicable++;
        if (cell.complete) complete++;
      }
      if (applicable === 0) {
        // No applicable forms → treat as fully complete (nothing to do).
        studentsFullyComplete++;
      } else if (complete === 0) {
        studentsNotStarted++;
      } else if (complete === applicable) {
        studentsFullyComplete++;
      } else {
        studentsInProgress++;
      }
    }
  }

  const stats = {
    enrolled_families: rows.length,
    families_fully_complete: rows.filter((r) => r.status === 'complete').length,
    families_in_progress: rows.filter((r) => r.status === 'in_progress').length,
    families_not_started: rows.filter((r) => r.status === 'not_started').length,
    total_students: rows.reduce((acc, r) => acc + r.enrolled_student_count, 0),
    students_fully_complete: studentsFullyComplete,
    students_in_progress: studentsInProgress,
    students_not_started: studentsNotStarted,
  };

  return {
    forms: formsForBuild,
    rows,
    stats,
    last_loaded_at: new Date().toISOString(),
  };
}
