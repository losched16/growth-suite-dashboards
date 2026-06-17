// Immunization status engine — pure, DB-free. Turns a student's recorded
// doses + flags + the NC schedule (schedule.ts) into:
//   - per-dose status   (the classroom grid glyphs, mirrors TC)
//   - per-vaccine status (the Section III per-vaccine report matrix)
//   - per-student status (Section I rollup + child-care summary)
//
// Kept pure so the classroom widget can reuse it client-side and so the
// report math is testable without a database.

import {
  VACCINES, REQUIRED_BY_CONTEXT, requirementForStudent,
  ageInMonths, NEAR_DUE_WINDOW_DAYS,
  type VaccineCode, type ReportContext, type DoseStatus, type RequirementSet,
} from './schedule';

// ── Input shapes (mirror the DB rows) ─────────────────────────────────
export interface DoseRow {
  vaccine_code: string;
  dose_number: number;
  date_administered: string | null;   // ISO
  status_override: 'not_applicable' | 'skipped' | null;
}
export interface VaccineFlag {
  vaccine_code: string;
  exemption: 'none' | 'medical' | 'religious';
  immunity_documented: boolean;
  not_required: boolean;
}
export interface ImmunizationProfile {
  certificate_on_file: boolean;
  all_vaccine_exemption: 'none' | 'medical' | 'religious';
  in_process: boolean;
  in_process_note?: string | null;
  report_context_override: ReportContext | null;
}
export interface StudentImmunizationInput {
  student_id: string;
  date_of_birth: string | null;        // ISO
  program: string | null;
  homeroom: string | null;
  grade: string | null;
  doses: DoseRow[];
  flags: VaccineFlag[];
  profile: ImmunizationProfile | null;
}

// The six report categories (NC K / 7th Section III) + a couple helpers.
export type ReportCategory =
  | 'up_to_date'
  | 'medical_exemption'
  | 'religious_exemption'
  | 'in_process'
  | 'incomplete_record'
  | 'no_record';

export interface VaccineStatus {
  vaccine: VaccineCode;
  required: number;            // min doses required in this context (0 = n/a)
  recorded: number;            // doses with a real date
  exemption: 'none' | 'medical' | 'religious';
  immunity: boolean;
  category: ReportCategory;    // this vaccine's status for the student
  doses: DoseStatus[];         // per-dose glyphs, length = VACCINES[v].maxDoses
}

export interface StudentStatus {
  student_id: string;
  context: ReportContext;
  ageMonths: number | null;
  vaccines: VaccineStatus[];
  overall: ReportCategory;     // Section I rollup category
  overdueVaccines: VaccineCode[];  // which vaccines are behind (for follow-ups)
}

// ── Context resolution ────────────────────────────────────────────────
// Resolve which NC report a student belongs to. Override wins; else
// derive from grade/program text; else fall back to age.
export function resolveContext(s: StudentImmunizationInput, asOf: Date): ReportContext {
  if (s.profile?.report_context_override) return s.profile.report_context_override;
  const hay = `${s.grade ?? ''} ${s.program ?? ''} ${s.homeroom ?? ''}`.toLowerCase();
  if (/(7th|seventh|grade 7)/.test(hay)) return 'grade_7';
  if (/(12th|twelfth|grade 12)/.test(hay)) return 'grade_12';
  // Elementary (incl. Montessori Lower/Upper Elementary) → school_other:
  // compliant, but not in any NC annual report.
  if (/(elementary|grade [1-6]|[1-6](st|nd|rd|th) grade)/.test(hay)) return 'school_other';
  // A DEDICATED kindergarten room maps to the K report — but ignore the
  // Montessori "Primary (3-5yrs, including Kindergarten)" label, which
  // mentions kindergarten without being a K cohort. So only when
  // "kindergarten" appears WITHOUT "primary".
  if (/kindergarten/.test(hay) && !/primary/.test(hay)) return 'kindergarten';
  // Otherwise (Primary, Stepping Stones, unknown) decide by age — the
  // Montessori K cohort is the 5-6yo tail of Primary.
  if (s.date_of_birth) {
    const months = ageInMonths(new Date(s.date_of_birth), asOf);
    if (months < 60) return 'child_care';            // under 5 → child care
    if (months < 78) return 'kindergarten';          // ~5-6.5yo → K cohort
    return 'school_other';                           // older, unlabeled → school
  }
  return 'child_care';
}

// Is this vaccine required at all for this student? (handles dropsAfterAge5)
function isVaccineRequired(v: VaccineCode, ctx: ReportContext, ageMonths: number | null, req: RequirementSet): boolean {
  const r = req[v];
  if (!r || r.min <= 0) return false;
  if (VACCINES[v].dropsAfterAge5 && ageMonths != null && ageMonths >= 60) return false;
  return true;
}

function countRecorded(doses: DoseRow[], v: VaccineCode): number {
  return doses.filter((d) => d.vaccine_code === v && d.date_administered && d.status_override !== 'skipped').length;
}

// Days until a child reaches a given age in months (negative = overdue).
function daysUntilAge(dob: Date, targetMonths: number, asOf: Date): number {
  const due = new Date(dob);
  due.setMonth(due.getMonth() + targetMonths);
  return Math.round((due.getTime() - asOf.getTime()) / 86400000);
}

// ── Per-vaccine computation ───────────────────────────────────────────
export function computeVaccine(
  s: StudentImmunizationInput, v: VaccineCode, ctx: ReportContext, ageMonths: number | null, asOf: Date,
): VaccineStatus {
  const def = VACCINES[v];
  const req = requirementForStudent(ctx, ageMonths ?? 0);
  const flag = s.flags.find((f) => f.vaccine_code === v);
  const allExempt = s.profile?.all_vaccine_exemption ?? 'none';
  const exemption = flag?.exemption && flag.exemption !== 'none' ? flag.exemption : (allExempt !== 'none' ? allExempt : 'none');
  const immunity = !!flag?.immunity_documented && def.immunityAllowed;
  const required = isVaccineRequired(v, ctx, ageMonths, req) && !flag?.not_required ? (req[v]?.min ?? 0) : 0;
  const recorded = countRecorded(s.doses, v);

  // Per-dose glyphs (TC mirror).
  const doses: DoseStatus[] = [];
  const dueDateForDose = (n: number): number | null => {
    // For child-care, map dose# to the ladder age it's typically due.
    // Approximation good enough for near-due/overdue coloring.
    if (!s.date_of_birth) return null;
    const dob = new Date(s.date_of_birth);
    // even spacing across the by-age window; conservative
    const targetMonths = ctx === 'child_care'
      ? [2, 4, 6, 15, 48][Math.min(n - 1, 4)]
      : [2, 4, 6, 15, 48][Math.min(n - 1, 4)];
    return daysUntilAge(dob, targetMonths, asOf);
  };
  for (let n = 1; n <= def.maxDoses; n++) {
    const doseRow = s.doses.find((d) => d.vaccine_code === v && d.dose_number === n);
    if (doseRow?.date_administered) { doses.push('done'); continue; }
    if (doseRow?.status_override === 'not_applicable') { doses.push('not_applicable'); continue; }
    if (exemption !== 'none') { doses.push('exempt'); continue; }
    if (required === 0 || n > required) { doses.push('not_applicable'); continue; }
    if (n <= recorded) { doses.push('done'); continue; }
    // first unmet required dose → due/overdue; later ones → upcoming
    if (n === recorded + 1) {
      const days = dueDateForDose(n);
      if (days == null) doses.push('overdue');
      else if (days < 0) doses.push('overdue');
      else if (days <= NEAR_DUE_WINDOW_DAYS) doses.push('near_due');
      else doses.push('upcoming');
    } else {
      doses.push('upcoming');
    }
  }

  // This vaccine's report category for the student.
  let category: ReportCategory;
  if (exemption === 'medical') category = 'medical_exemption';
  else if (exemption === 'religious') category = 'religious_exemption';
  else if (required === 0) category = 'up_to_date';            // not required → counts as compliant
  else if (immunity) category = 'up_to_date';
  else if (recorded >= required) category = 'up_to_date';
  else if (!s.profile?.certificate_on_file) category = 'no_record';
  else if (s.profile?.in_process) category = 'in_process';
  else category = 'incomplete_record';

  return { vaccine: v, required, recorded, exemption, immunity, category, doses };
}

// Which vaccines apply to a context (the columns to render).
export function vaccinesForContext(ctx: ReportContext): VaccineCode[] {
  return Object.keys(REQUIRED_BY_CONTEXT[ctx]) as VaccineCode[];
}

// ── Per-student computation ───────────────────────────────────────────
export function computeStudent(s: StudentImmunizationInput, asOf: Date): StudentStatus {
  const ctx = resolveContext(s, asOf);
  const ageMonths = s.date_of_birth ? ageInMonths(new Date(s.date_of_birth), asOf) : null;
  const cols = vaccinesForContext(ctx);
  const vaccines = cols.map((v) => computeVaccine(s, v, ctx, ageMonths, asOf));

  // Section I rollup.
  const allExempt = s.profile?.all_vaccine_exemption ?? 'none';
  let overall: ReportCategory;
  if (allExempt === 'medical') overall = 'medical_exemption';
  else if (allExempt === 'religious') overall = 'religious_exemption';
  else if (!s.profile?.certificate_on_file) overall = 'no_record';
  else {
    const everyDone = vaccines.every((vs) => vs.category === 'up_to_date'
      || vs.category === 'medical_exemption' || vs.category === 'religious_exemption');
    if (everyDone) overall = 'up_to_date';
    else if (s.profile?.in_process) overall = 'in_process';
    else overall = 'incomplete_record';
  }

  const overdueVaccines = vaccines
    .filter((vs) => vs.category === 'incomplete_record' || vs.category === 'no_record')
    .map((vs) => vs.vaccine);

  return { student_id: s.student_id, context: ctx, ageMonths, vaccines, overall, overdueVaccines };
}

// ── Report rollups ────────────────────────────────────────────────────
export interface SectionIIICounts {
  vaccine: VaccineCode;
  up_to_date: number;
  medical_exemption: number;
  religious_exemption: number;
  in_process: number;
  incomplete_record: number;
  no_record: number;
  total: number;
}

export interface NcReport {
  context: ReportContext;
  enrollment: number;
  // Section I
  all_required_doses: number;   // 3a
  medical_exemption: number;    // 3b (all-vaccine)
  religious_exemption: number;  // 3c (all-vaccine)
  not_up_to_date: number;       // 3d = in_process + incomplete + no_record
  // Section I sub-questions
  in_process: number;           // Q7
  no_record: number;            // Q8
  // Section III matrix
  by_vaccine: SectionIIICounts[];
}

export function buildReport(students: StudentStatus[], ctx: ReportContext): NcReport {
  const inCtx = students.filter((s) => s.context === ctx);
  const cols = vaccinesForContext(ctx);
  const allExemptMedical = inCtx.filter((s) => s.overall === 'medical_exemption').length;
  const allExemptReligious = inCtx.filter((s) => s.overall === 'religious_exemption').length;
  const utd = inCtx.filter((s) => s.overall === 'up_to_date').length;
  const inProc = inCtx.filter((s) => s.overall === 'in_process').length;
  const noRec = inCtx.filter((s) => s.overall === 'no_record').length;
  const incomplete = inCtx.filter((s) => s.overall === 'incomplete_record').length;

  const by_vaccine: SectionIIICounts[] = cols.map((v) => {
    const c: SectionIIICounts = { vaccine: v, up_to_date: 0, medical_exemption: 0, religious_exemption: 0, in_process: 0, incomplete_record: 0, no_record: 0, total: inCtx.length };
    for (const s of inCtx) {
      const vs = s.vaccines.find((x) => x.vaccine === v);
      if (!vs) { c.up_to_date++; continue; }
      c[vs.category]++;
    }
    return c;
  });

  return {
    context: ctx,
    enrollment: inCtx.length,
    all_required_doses: utd,
    medical_exemption: allExemptMedical,
    religious_exemption: allExemptReligious,
    not_up_to_date: inProc + incomplete + noRec,
    in_process: inProc,
    no_record: noRec,
    by_vaccine,
  };
}

// Child-care summary table (the DCD age-group table). Buckets by age.
export interface ChildCareSummaryRow {
  label: string;
  attending: number;
  up_to_date: number;
  in_process: number;
  not_utd_no_exemption: number;
  medical_exemption: number;
  religious_exemption: number;
}
export function buildChildCareSummary(students: StudentStatus[]): ChildCareSummaryRow[] {
  const cc = students.filter((s) => s.context === 'child_care');
  const bands: Array<{ label: string; test: (m: number | null) => boolean }> = [
    { label: '0 through 24 months', test: (m) => m != null && m < 24 },
    { label: '24 months up to first day of kindergarten', test: (m) => m == null || m >= 24 },
  ];
  return bands.map((b) => {
    const rows = cc.filter((s) => b.test(s.ageMonths));
    return {
      label: b.label,
      attending: rows.length,
      up_to_date: rows.filter((s) => s.overall === 'up_to_date').length,
      in_process: rows.filter((s) => s.overall === 'in_process').length,
      not_utd_no_exemption: rows.filter((s) => s.overall === 'incomplete_record' || s.overall === 'no_record').length,
      medical_exemption: rows.filter((s) => s.overall === 'medical_exemption').length,
      religious_exemption: rows.filter((s) => s.overall === 'religious_exemption').length,
    };
  });
}
