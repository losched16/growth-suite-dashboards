// PortalFormsTracker data fetcher. Builds the family-row grid by:
//   1. Loading active parent-portal forms for the school
//   2. Walking every active family with at least one currently-enrolled
//      student
//   3. For each (family, form), computing the per-student chip status
//      from portal_form_submissions

import { query } from '@/lib/db';
import { loadSchoolSettings } from '@/lib/school-settings';
import type { SchoolContext, WidgetSearchParams } from '@/lib/widgets/types';
import type { PortalFormsTrackerConfig } from './config';

export interface FormDef {
  id: string;
  slug: string;
  display_name: string;
  category: string | null;
  per_student: boolean;
  position: number;
  // True for office-recorded items (config.external_items) tracked from
  // student metadata — no submission behind the chip, so no drill link.
  external?: boolean;
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
  // How many of this family's tracked students are pending (mid-admissions).
  // Nonzero → the row gets a "pending" badge so the office can tell who's
  // still in process vs. currently enrolled.
  pending_student_count: number;
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
    // Of total_students, how many are pending (only nonzero when the
    // include_pending config is on) — surfaced so the header can label
    // them instead of silently inflating the "enrolled" number.
    pending_students: number;
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
  // Tag-based visibility rules (subset of applies_to the tracker can
  // evaluate at the family level). A form hidden from a family must not
  // count as "missing" for them.
  applies_to: { tag_match?: string[]; tag_exclude?: string[] } | null;
}

interface DbStudent {
  student_id: string;
  family_id: string;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
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
    `SELECT id, slug, display_name, category, per_student, applies_to,
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

  // 2. Enrolled students — the SAME strict rule as the Student Roster:
  //    active student whose current-year enrollment status (from the GHL
  //    contact record, via the enrollments table) is 'enrolled'. Demo
  //    records excluded like every other hub. include_pending widens the
  //    scope to mid-admissions families doing their enrollment paperwork.
  const settings = await loadSchoolSettings(school.schoolId);
  // Default ON — only an explicit false pins the tracker to enrolled-only,
  // so widgets saved before this option existed get the intended behavior.
  const includePending = config.include_pending !== false;
  const enrollmentScope = includePending ? ['enrolled', 'pending'] : ['enrolled'];
  const { rows: students } = await query<DbStudent>(
    `SELECT s.id AS student_id, s.family_id,
            s.first_name, s.last_name, s.preferred_name,
            e.status AS enrollment_status
       FROM students s
       LEFT JOIN LATERAL (
         -- Prefer the selected academic year's enrollment; fall back to
         -- the most recent one (mirrors StudentRosterRich).
         SELECT e2.status FROM enrollments e2 WHERE e2.student_id = s.id
          ORDER BY (e2.academic_year = $2) DESC, e2.created_at DESC LIMIT 1
       ) e ON true
      WHERE s.school_id = $1 AND s.status = 'active'
        AND (s.metadata->>'is_demo') IS DISTINCT FROM 'true'
        AND e.status = ANY($3::text[])
      ORDER BY s.family_id, s.first_name`,
    [school.schoolId, settings.academic_year, enrollmentScope],
  );
  const scopedFamilyIds = [...new Set(students.map((s) => s.family_id))];

  // 2b. Office-recorded items — per-student completion from
  // students.metadata (the sync mirrors each GHL per-student custom field
  // there, e.g. "Student 1 AZ Card" → metadata.az_card). One small query
  // per configured item.
  const externalItems = (Array.isArray(config.external_items) ? config.external_items : [])
    .filter((i) => i && i.key && i.label && i.metadata_key);
  const externalComplete = new Map<string, Set<string>>();
  for (const item of externalItems) {
    const done = new Set<string>();
    if (students.length > 0) {
      const okValues = (item.complete_values?.length ? item.complete_values : ['complete', 'yes', 'done'])
        .map((v) => v.trim().toLowerCase());
      const { rows: mrows } = await query<{ id: string; v: string | null }>(
        `SELECT id, metadata->>$2 AS v FROM students
          WHERE school_id = $1 AND id = ANY($3::uuid[])`,
        [school.schoolId, item.metadata_key, students.map((s) => s.student_id)],
      );
      for (const r of mrows) {
        if (r.v && okValues.includes(r.v.trim().toLowerCase())) done.add(r.id);
      }
    }
    externalComplete.set(item.key, done);
  }

  // 3. Family metadata + primary parent. The optional tag filter
  // (enrolled_tag / excluded_tag) checks every parent on the family —
  // include if ANY parent has the enrolled tag, exclude if ANY parent
  // has the excluded tag. Joe's framing: a withdrawn-tagged contact
  // anywhere on the family drops the whole family out of the tracker.
  const enrolledTag = (config.enrolled_tag ?? '').trim().toLowerCase();
  const excludedTag = (config.excluded_tag ?? '').trim().toLowerCase();
  const { rows: famMeta } = await query<DbFamilyMeta>(
    `SELECT f.id AS family_id,
            f.display_name AS family_display_name,
            (SELECT first_name FROM parents p WHERE p.family_id = f.id AND p.is_primary = true LIMIT 1) AS primary_first,
            (SELECT last_name FROM parents p WHERE p.family_id = f.id AND p.is_primary = true LIMIT 1) AS primary_last,
            (SELECT email FROM parents p WHERE p.family_id = f.id AND p.is_primary = true LIMIT 1) AS primary_email,
            (SELECT ghl_contact_id FROM parents p WHERE p.family_id = f.id AND p.is_primary = true LIMIT 1) AS primary_ghl_contact_id
       FROM families f
      WHERE f.school_id = $1
        -- Only families with at least one in-scope (enrolled) student —
        -- derived from the scoped student list above so the family count
        -- can never disagree with the student count.
        AND f.id = ANY($4::uuid[])
        AND ($2::text = '' OR EXISTS (
          SELECT 1 FROM parents p
            JOIN ghl_contact_tags t ON t.ghl_contact_id = p.ghl_contact_id AND t.school_id = $1
           WHERE p.family_id = f.id AND p.status = 'active'
             AND lower(t.tag) = $2
        ))
        AND ($3::text = '' OR NOT EXISTS (
          SELECT 1 FROM parents p
            JOIN ghl_contact_tags t ON t.ghl_contact_id = p.ghl_contact_id AND t.school_id = $1
           WHERE p.family_id = f.id AND p.status = 'active'
             AND lower(t.tag) = $3
        ))`,
    [school.schoolId, enrolledTag, excludedTag, scopedFamilyIds],
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
                -- UTC + explicit 'Z': to_char's OF emits '+00', which JS
                -- Date() rejects → every chip tooltip said "Invalid Date".
                to_char(s.submitted_at AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS submitted_at
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

  // ── Family → contact tags, to honor tag-based form visibility ─────
  // A form hidden from a family (applies_to.tag_exclude, or tag_match
  // they don't carry) must not count as "missing" for them — otherwise
  // hiding e.g. the enrollment agreement from already-enrolled families
  // would flip every enrolled family to "not started".
  const tagsByFamily = new Map<string, Set<string>>();
  if (familyIds.length > 0) {
    const { rows: ftRows } = await query<{ family_id: string; tag: string }>(
      `SELECT DISTINCT p.family_id, LOWER(t.tag) AS tag
         FROM ghl_contact_tags t
         JOIN parents p ON p.ghl_contact_id = t.ghl_contact_id
        WHERE t.school_id = $1 AND p.family_id = ANY($2::uuid[])`,
      [school.schoolId, familyIds],
    );
    for (const r of ftRows) {
      if (!tagsByFamily.has(r.family_id)) tagsByFamily.set(r.family_id, new Set());
      tagsByFamily.get(r.family_id)!.add(r.tag);
    }
  }
  function formVisibleToFamily(form: DbForm, familyId: string): boolean {
    const rule = form.applies_to;
    if (!rule) return true;
    const have = tagsByFamily.get(familyId) ?? new Set<string>();
    if (rule.tag_exclude?.length && rule.tag_exclude.some((t) => have.has(t.toLowerCase()))) {
      return false;
    }
    if (rule.tag_match?.length && !rule.tag_match.some((t) => have.has(t.toLowerCase()))) {
      return false;
    }
    return true;
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

  // ── GHL-side completion signal ───────────────────────────────────
  // Old workflow: parents completed forms via Final Forms / GHL-native
  // surveys, which write `form_<slug>_complete` (family-level) or
  // `form_<slug>_s<N>` (per-student slot N) custom fields onto the
  // primary parent's GHL contact. These predate the portal and never
  // land in portal_form_submissions. Without honoring them, families
  // that already finished paperwork show as 0/8 in the tracker and
  // keep getting reminder emails. Sonia flagged Tracy Cosgriff /
  // August as a repro — Tracy has form_emergency_medical_complete,
  // form_media_permission_complete, form_ode_connectivity_complete
  // set to 2026-07-06 in GHL but no matching portal submissions.
  //
  // We treat a form as complete if EITHER signal exists.
  const ghlFormKeys = new Map<string, Set<string>>(); // familyId → set of form-* field keys with a non-empty value
  const primaryContactIds = famMeta
    .map((f) => f.primary_ghl_contact_id)
    .filter((v): v is string => !!v);
  if (primaryContactIds.length > 0) {
    const { rows: ghlRows } = await query<{ ghl_contact_id: string; field_key: string }>(
      `SELECT ghl_contact_id, field_key FROM ghl_contact_field_values
        WHERE school_id = $1
          AND ghl_contact_id = ANY($2::text[])
          AND field_key ~ '^form_[a-z_]+(_complete(_s[1-6])?|_s[1-6])$'
          AND value IS NOT NULL AND value <> ''`,
      [school.schoolId, primaryContactIds],
    );
    const familyByContact = new Map<string, string>();
    for (const f of famMeta) {
      if (f.primary_ghl_contact_id) familyByContact.set(f.primary_ghl_contact_id, f.family_id);
    }
    for (const r of ghlRows) {
      const familyId = familyByContact.get(r.ghl_contact_id);
      if (!familyId) continue;
      if (!ghlFormKeys.has(familyId)) ghlFormKeys.set(familyId, new Set());
      ghlFormKeys.get(familyId)!.add(r.field_key);
    }
  }
  function ghlComplete(familyId: string, formSlug: string, opts: { slot?: number; familyLevel: boolean }): boolean {
    const set = ghlFormKeys.get(familyId);
    if (!set) return false;
    const slugKey = formSlug.replace(/-/g, '_');
    if (opts.familyLevel) {
      if (set.has(`form_${slugKey}_complete`)) return true;
      // Emergency-medical also has per-student variants (_complete_s2,
      // _complete_s3). Treat ANY populated variant as "family-level
      // signal present" — matches how Sonia reads Family Hub.
      for (let i = 1; i <= 6; i++) {
        if (set.has(`form_${slugKey}_complete_s${i}`)) return true;
        if (set.has(`form_${slugKey}_s${i}`)) return true;
      }
      return false;
    }
    const slot = opts.slot ?? 1;
    return set.has(`form_${slugKey}_s${slot}`)
        || set.has(`form_${slugKey}_complete_s${slot}`)
        // Slot 1 also maps to the un-suffixed _complete field on
        // some schools' setups.
        || (slot === 1 && set.has(`form_${slugKey}_complete`));
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
  // Office-recorded items render as extra per-student columns after the
  // real forms.
  for (const item of externalItems) {
    formsForBuild.push({
      id: `external:${item.key}`,
      slug: `external-${item.key}`,
      display_name: item.label,
      category: null,
      per_student: true,
      position: 1000,
      external: true,
    });
  }

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
      // Office-recorded item: chip complete when the student's mirrored
      // metadata value says so. No submission to link to.
      if (form.external) {
        const done = externalComplete.get(form.id.slice('external:'.length)) ?? new Set<string>();
        cells[form.id] = familyStudents.map((s, i) => {
          const complete = done.has(s.student_id);
          applicableCount++;
          if (complete) completeCount++;
          return {
            student_id: s.student_id,
            slot: i + 1,
            display_name: studentLabel(s),
            applies: true,
            complete,
            submission_id: null,
            submitted_at: null,
          };
        });
        continue;
      }
      // Hidden from this family by tag rules → not applicable, blank cell.
      if (!formVisibleToFamily(forms.find((f) => f.id === form.id)!, fam.family_id)) {
        cells[form.id] = [];
        continue;
      }
      if (form.per_student) {
        // One chip per student in the family. All of them are "applicable"
        // by default; per-school applicability rules would land here later.
        // Completion is EITHER a portal submission or a GHL-side signal
        // (`form_<slug>_s<N>` on the primary parent's contact) — see the
        // ghlComplete helper above.
        const list: StudentChip[] = familyStudents.map((s, i) => {
          const sub = perStudent.get(`${form.id}|${s.student_id}`);
          const complete = !!sub
            || ghlComplete(fam.family_id, form.slug, { slot: i + 1, familyLevel: false });
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
        // Same dual-signal rule: portal submission OR any populated
        // `form_<slug>_complete[_sN]` field.
        const sub = perFamily.get(`${form.id}|${fam.family_id}`);
        const complete = !!sub
          || ghlComplete(fam.family_id, form.slug, { familyLevel: true });
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
      pending_student_count: familyStudents.filter((s) => s.enrollment_status === 'pending').length,
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
    pending_students: students.filter((s) => s.enrollment_status === 'pending').length,
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
