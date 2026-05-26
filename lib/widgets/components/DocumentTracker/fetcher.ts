// DocumentTracker data fetcher. Loads the school's configured forms from
// school_forms, then walks families + students from family-graph,
// computing per-family completion stats.

import { query } from '@/lib/db';
import type { SchoolContext, WidgetSearchParams } from '@/lib/widgets/types';
import type { DocumentTrackerConfig } from './config';

export interface FormDef {
  id: string;
  completion_field_key: string;
  display_name: string;
  description: string | null;
  per_student: boolean;
  position: number;
}

export interface StudentChip {
  student_id: string;
  slot: number;
  display_name: string;
  applies: boolean;     // does this form apply to this student
  complete: boolean;
  completed_value: string | null;
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
  // Per form key → chip per student
  cells: Record<string, StudentChip[]>;
  applicable_count: number;
  complete_count: number;
  pct: number;
  status: 'complete' | 'in_progress' | 'not_started';
}

export interface DocumentTrackerData {
  forms: FormDef[];
  rows: FamilyRow[];
  // Stats across rows
  stats: {
    enrolled_families: number;
    total_students: number;
    fully_complete: number;
    in_progress: number;
    not_started: number;
  };
}

interface DbForm {
  id: string;
  completion_field_key: string;
  display_name: string;
  description: string | null;
  per_student: boolean;
  position: number;
}

interface DbStudent {
  student_id: string;
  family_id: string;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  metadata: Record<string, unknown>;
  enrollment_status: string | null;
}

interface DbFamilyMeta {
  family_id: string;
  family_display_name: string | null;
  primary_first: string | null;
  primary_last: string | null;
  primary_email: string | null;
  primary_ghl_contact_id: string | null;
}

// Should a form key be considered "applicable" to a given student?
// Heuristic: SST forms apply only to SST students; sports/enrichment
// only to students with service_1/service_2; summer only to summer
// participants. Caller can extend this per-school later.
function isApplicable(
  form: FormDef,
  student: { metadata: Record<string, unknown> },
): boolean {
  const md = student.metadata ?? {};
  const fk = form.completion_field_key.toLowerCase();
  if (/^sst|_sst_|sst$/.test(fk)) {
    const v = String(md.sst_status ?? '').toLowerCase();
    return !!v && !['no', 'none', 'n/a', 'na', '0', 'false'].includes(v);
  }
  if (/sports|enrichment|service/.test(fk)) {
    return !!md.service_1 || !!md.service_2 || !!md.service1 || !!md.service2;
  }
  if (/summer/.test(fk)) {
    return !!md.summer_program || !!md.summerProgram || !!md.summer_schedule || !!md.summerSchedule;
  }
  return true;
}

export async function fetcher(
  school: SchoolContext,
  _config: DocumentTrackerConfig,
  _searchParams?: WidgetSearchParams,
): Promise<DocumentTrackerData> {
  // 1. School's configured forms (legacy school_forms table — populated
  // for schools using the GHL-webhook flow).
  const { rows: legacyForms } = await query<DbForm>(
    `SELECT id, completion_field_key, display_name, description, per_student, position
     FROM school_forms
     WHERE school_id = $1 AND is_active = true
     ORDER BY position, display_name`,
    [school.schoolId],
  );

  // 1b. Native parent-portal forms (audience='parents'). When school_forms
  // is empty we derive the tracker columns from these so brand-new schools
  // get a working tracker the moment their forms are seeded — no extra
  // configuration step. When school_forms is also populated, the native
  // forms append after the legacy ones.
  const { rows: nativeFormDefs } = await query<{
    id: string;
    slug: string;
    display_name: string;
    description: string | null;
    per_student: boolean;
  }>(
    `SELECT id, slug, display_name, description, per_student
     FROM portal_form_definitions
     WHERE school_id = $1 AND audience = 'parents' AND is_active = true
     ORDER BY display_name`,
    [school.schoolId],
  );

  // Build the unified `forms` list. Each form may have either:
  //   - A legacy metadata key (completion read from students.metadata.form_completion[key])
  //   - A native portal_form_definition_id (completion read from portal_form_submissions)
  // Disambiguated by the nativeFormDefId field below.
  type UnifiedForm = DbForm & { nativeFormDefId: string | null };
  const legacyKeysAlreadyMatched = new Set<string>();
  const forms: UnifiedForm[] = [];

  for (const lf of legacyForms) {
    // If a legacy school_forms row's completion_field_key happens to
    // match a native portal form's slug, prefer the native source (so
    // admins can migrate by just renaming the key — no double-counting).
    const matchedNative = nativeFormDefs.find((nf) => nf.slug === lf.completion_field_key);
    if (matchedNative) legacyKeysAlreadyMatched.add(lf.completion_field_key);
    forms.push({ ...lf, nativeFormDefId: matchedNative?.id ?? null });
  }
  // Append native forms that weren't already matched as a legacy row.
  let nextPos = (legacyForms[legacyForms.length - 1]?.position ?? 0) + 1;
  for (const nf of nativeFormDefs) {
    if (legacyKeysAlreadyMatched.has(nf.slug)) continue;
    forms.push({
      id: nf.id,
      completion_field_key: nf.slug,
      display_name: nf.display_name,
      description: nf.description,
      per_student: nf.per_student,
      position: nextPos++,
      nativeFormDefId: nf.id,
    });
  }

  if (forms.length === 0) {
    return {
      forms: [],
      rows: [],
      stats: { enrolled_families: 0, total_students: 0, fully_complete: 0, in_progress: 0, not_started: 0 },
    };
  }

  // 1c. Pull native submissions for ALL the native forms in one query.
  // Build lookup: nativeFormDefId -> Set<student_id|family_id>
  // student_id is used for per_student forms, family_id for per-family forms.
  const nativeFormDefIds = forms.map((f) => f.nativeFormDefId).filter(Boolean) as string[];
  const studentSubmissions = new Map<string, Set<string>>(); // form_def_id -> student_ids
  const familySubmissions  = new Map<string, Set<string>>(); // form_def_id -> family_ids
  if (nativeFormDefIds.length > 0) {
    const { rows: subRows } = await query<{
      form_definition_id: string;
      student_id: string | null;
      family_id: string | null;
      status: string;
    }>(
      `SELECT form_definition_id, student_id, family_id, status
         FROM portal_form_submissions
        WHERE school_id = $1
          AND form_definition_id = ANY($2::uuid[])
          AND status IN ('submitted', 'paid')
          AND (is_test IS NULL OR is_test = false)
          AND voided_at IS NULL`,
      [school.schoolId, nativeFormDefIds],
    );
    for (const sub of subRows) {
      if (sub.student_id) {
        const set = studentSubmissions.get(sub.form_definition_id) ?? new Set();
        set.add(sub.student_id);
        studentSubmissions.set(sub.form_definition_id, set);
      }
      if (sub.family_id) {
        const set = familySubmissions.get(sub.form_definition_id) ?? new Set();
        set.add(sub.family_id);
        familySubmissions.set(sub.form_definition_id, set);
      }
    }
  }

  // 2. Family metadata (one row per family with primary parent)
  const { rows: famRows } = await query<DbFamilyMeta>(
    `SELECT
       f.id AS family_id,
       f.display_name AS family_display_name,
       p.first_name AS primary_first,
       p.last_name AS primary_last,
       p.email AS primary_email,
       p.ghl_contact_id AS primary_ghl_contact_id
     FROM families f
     LEFT JOIN LATERAL (
       SELECT first_name, last_name, email, ghl_contact_id FROM parents pp
       WHERE pp.family_id = f.id AND pp.status = 'active'
       ORDER BY is_primary DESC, created_at LIMIT 1
     ) p ON true
     WHERE f.school_id = $1`,
    [school.schoolId],
  );

  // 3. Students (with most recent enrollment status for "enrolled" filter)
  const { rows: studentRows } = await query<DbStudent>(
    `SELECT
       s.id AS student_id, s.family_id,
       s.first_name, s.last_name, s.preferred_name, s.metadata,
       (SELECT status FROM enrollments e WHERE e.student_id = s.id ORDER BY created_at DESC LIMIT 1) AS enrollment_status
     FROM students s
     WHERE s.school_id = $1 AND s.status = 'active'
     ORDER BY s.family_id, s.first_name`,
    [school.schoolId],
  );

  // Group students by family
  const studentsByFamily = new Map<string, DbStudent[]>();
  for (const s of studentRows) {
    const list = studentsByFamily.get(s.family_id) ?? [];
    list.push(s);
    studentsByFamily.set(s.family_id, list);
  }

  // 4. Build per-family rows
  const rows: FamilyRow[] = [];
  let totalStudents = 0;
  for (const fam of famRows) {
    const allStudents = studentsByFamily.get(fam.family_id) ?? [];
    const enrolled = allStudents.filter((s) =>
      s.enrollment_status && /enrolled|accepted/i.test(s.enrollment_status),
    );
    if (enrolled.length === 0) continue;

    totalStudents += enrolled.length;
    const enrolledStudents = enrolled.map((s, i) => ({
      student_id: s.student_id,
      slot: typeof s.metadata?.ghl_slot === 'number'
        ? (s.metadata.ghl_slot as number)
        : i + 1,
      display_name: s.preferred_name || s.first_name,
    }));

    const cells: FamilyRow['cells'] = {};
    let applicable = 0;
    let complete = 0;
    for (const form of forms) {
      // For native forms, completion comes from portal_form_submissions
      // (student-keyed for per_student=true, family-keyed otherwise).
      // For legacy forms, fall back to students.metadata.form_completion[key].
      const nativeStudentSet = form.nativeFormDefId ? studentSubmissions.get(form.nativeFormDefId) : null;
      const familySubmitted  = form.nativeFormDefId
        ? (familySubmissions.get(form.nativeFormDefId)?.has(fam.family_id) ?? false)
        : false;

      const row: StudentChip[] = enrolled.map((s, i) => {
        const applies = isApplicable(form as FormDef, s);
        let done = false;
        let valueStr: string | null = null;

        if (form.nativeFormDefId) {
          // Native portal form completion path
          if (form.per_student) {
            done = applies && (nativeStudentSet?.has(s.student_id) ?? false);
          } else {
            // Per-family form: every child in the family shares the family-level completion
            done = applies && familySubmitted;
          }
          if (done) valueStr = 'submitted';
        } else {
          // Legacy GHL-metadata completion path
          const completion = s.metadata?.form_completion as Record<string, unknown> | undefined;
          const value = completion?.[form.completion_field_key];
          valueStr = typeof value === 'string' ? value.trim() : '';
          done = applies && !!valueStr;
        }

        if (applies) {
          applicable++;
          if (done) complete++;
        }
        return {
          student_id: s.student_id,
          slot: typeof s.metadata?.ghl_slot === 'number' ? (s.metadata.ghl_slot as number) : i + 1,
          display_name: s.preferred_name || s.first_name,
          applies,
          complete: done,
          completed_value: valueStr || null,
        };
      });
      cells[form.id] = row;
    }

    const pct = applicable === 0 ? 100 : Math.round((complete / applicable) * 100);
    const status: FamilyRow['status'] =
      applicable === 0 || pct === 100
        ? 'complete'
        : complete === 0
          ? 'not_started'
          : 'in_progress';

    const primaryName = `${fam.primary_first ?? ''} ${fam.primary_last ?? ''}`.trim() || '(unnamed)';

    rows.push({
      family_id: fam.family_id,
      family_display_name: fam.family_display_name ?? `${fam.primary_last ?? primaryName} Family`,
      primary_parent_name: primaryName,
      primary_parent_email: fam.primary_email,
      primary_parent_ghl_contact_id: fam.primary_ghl_contact_id,
      enrolled_student_count: enrolled.length,
      enrolled_students: enrolledStudents,
      cells,
      applicable_count: applicable,
      complete_count: complete,
      pct,
      status,
    });
  }

  const stats = {
    enrolled_families: rows.length,
    total_students: totalStudents,
    fully_complete: rows.filter((r) => r.status === 'complete').length,
    in_progress: rows.filter((r) => r.status === 'in_progress').length,
    not_started: rows.filter((r) => r.status === 'not_started').length,
  };

  return { forms: forms as FormDef[], rows, stats };
}
