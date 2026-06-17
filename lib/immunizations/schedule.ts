// NC immunization schedule — the single source of truth the tracker
// runs on. This file is intentionally plain DATA (+ pure helpers) so:
//   1. Mara / NC DHHS can review the requirements without reading logic.
//   2. It imports nothing server-only (no pg), so the classroom widget
//      can use the same status math client-side.
//
// SOURCES (authoritative):
//   - Child-care by-age ladder: NC DCD 0108 "Child Immunization History"
//     → "Minimum State Vaccine Requirements for Child Care Entry"
//     (the sheet MCS sent us — this one is exact).
//   - K / 7th / 12th counts: NC DHHS, dph.ncdhhs.gov/.../schools/k-12
//     (confirmed 2026-06-17). Verify against the school's formal state
//     sheet before reports are filed.
//
// MODEL NOTE: immunizations are tracked by DUE-BY-AGE, not "expiration."
// Each dose is due by a target age; the engine flags near-due / overdue.
// (Document expiration — DCD medical report, TB test — lives elsewhere
// on student_documents.expires_at, not here.)

export type VaccineCode =
  | 'dtap' | 'ipv' | 'hib' | 'hepb' | 'mmr' | 'var' | 'pcv' | 'tdap' | 'mcv';

export interface VaccineDef {
  code: VaccineCode;
  label: string;            // full display name
  short: string;            // column header
  aliases: string;          // trade/abbrev names shown under the header (mirrors TC)
  /** Proof of immunity (titer / history of disease) counts as up-to-date.
   *  NC allows this for measles, mumps, rubella, and varicella. */
  immunityAllowed: boolean;
  /** Not required once the child passes their 5th birthday (child-care only vaccines). */
  dropsAfterAge5: boolean;
  maxDoses: number;         // how many dose rows to render (mirrors TC grid)
}

export const VACCINES: Record<VaccineCode, VaccineDef> = {
  dtap: { code: 'dtap', label: 'Diphtheria, Tetanus, Pertussis', short: 'DTaP', aliases: 'DTaP · DT · DTP', immunityAllowed: false, dropsAfterAge5: false, maxDoses: 5 },
  ipv:  { code: 'ipv',  label: 'Polio',                          short: 'Polio', aliases: 'IPV · OPV',     immunityAllowed: false, dropsAfterAge5: false, maxDoses: 4 },
  hib:  { code: 'hib',  label: 'Haemophilus influenzae type b',  short: 'Hib',   aliases: 'PRP-T · PRP-OMP', immunityAllowed: false, dropsAfterAge5: true,  maxDoses: 4 },
  hepb: { code: 'hepb', label: 'Hepatitis B',                    short: 'Hep B', aliases: 'HepB · HBV',    immunityAllowed: false, dropsAfterAge5: false, maxDoses: 3 },
  mmr:  { code: 'mmr',  label: 'Measles, Mumps, Rubella',        short: 'MMR',   aliases: 'MMR · MMRV · ProQuad', immunityAllowed: true, dropsAfterAge5: false, maxDoses: 2 },
  var:  { code: 'var',  label: 'Varicella (Chickenpox)',         short: 'Var',   aliases: 'VARIVAX · MMRV · ProQuad', immunityAllowed: true, dropsAfterAge5: false, maxDoses: 2 },
  pcv:  { code: 'pcv',  label: 'Pneumococcal Conjugate',         short: 'PCV',   aliases: 'PCV13 · PPSV23', immunityAllowed: false, dropsAfterAge5: true,  maxDoses: 4 },
  tdap: { code: 'tdap', label: 'Tdap (Tetanus, Diphtheria, Pertussis booster)', short: 'Tdap', aliases: 'Boostrix · Adacel · TENIVAC', immunityAllowed: false, dropsAfterAge5: false, maxDoses: 2 },
  mcv:  { code: 'mcv',  label: 'Meningococcal Conjugate',        short: 'Mening.', aliases: 'MenACWY · Menactra · Menveo · MenQuadfi', immunityAllowed: false, dropsAfterAge5: false, maxDoses: 2 },
};

// ── Which NC report a student rolls into ──────────────────────────────
// MCS is licensed as a child-care facility AND a school, so it files all
// three. Membership is by grade/age; the engine resolves it from the
// student's program/grade (with DOB fallback). report_context can be
// overridden per-student.
// 'school_other' = grades 1-6 / 8-11: must stay compliant (K-level
// requirements persist) and show in the grid, but NC files NO separate
// annual report for them, so buildReport is never called for this ctx.
export type ReportContext = 'child_care' | 'kindergarten' | 'school_other' | 'grade_7' | 'grade_12';

// ── Required-dose targets for the "fully up to date" determination ────
// (Used by the annual REPORT compliance counts. Hib/PCV use a [min,max]
// because NC's required count is brand-dependent — see note below.)
export interface Requirement { min: number; max?: number; }
export type RequirementSet = Partial<Record<VaccineCode, Requirement>>;

export const REQUIRED_BY_CONTEXT: Record<ReportContext, RequirementSet> = {
  // Child care, 4yr+ steady state (younger ages use BY_AGE_LADDER below).
  child_care:   { dtap: { min: 4 }, ipv: { min: 3 }, mmr: { min: 1 }, hib: { min: 3, max: 4 }, hepb: { min: 3 }, pcv: { min: 4 }, var: { min: 1 } },
  // Kindergarten steps the boosters up; Hib/PCV age out (dropsAfterAge5).
  kindergarten: { dtap: { min: 5 }, ipv: { min: 4 }, mmr: { min: 2 }, hib: { min: 3, max: 4 }, hepb: { min: 3 }, pcv: { min: 4 }, var: { min: 2 } },
  // Grades 1-6 etc.: same standing requirements as K (Hib/PCV already
  // aged out). Tracked in the grid; NOT in any NC annual report.
  school_other: { dtap: { min: 5 }, ipv: { min: 4 }, mmr: { min: 2 }, hepb: { min: 3 }, var: { min: 2 } },
  // 7th grade = all K requirements + the adolescent boosters.
  grade_7:      { dtap: { min: 5 }, ipv: { min: 4 }, mmr: { min: 2 }, hepb: { min: 3 }, var: { min: 2 }, tdap: { min: 1 }, mcv: { min: 1 } },
  // 12th grade adds the meningococcal booster (2nd dose).
  grade_12:     { dtap: { min: 5 }, ipv: { min: 4 }, mmr: { min: 2 }, hepb: { min: 3 }, var: { min: 2 }, tdap: { min: 1 }, mcv: { min: 2 } },
};

// ── Child-care by-age ladder (the DCD 0108 minimums) ──────────────────
// "By this age the child needs at least these doses." Drives near-due /
// overdue for the under-5 set. ageMonths is the deadline age.
export interface LadderRung { ageMonths: number; req: RequirementSet; }
export const BY_AGE_LADDER: LadderRung[] = [
  { ageMonths: 3,  req: { hepb: { min: 1 } } },
  { ageMonths: 5,  req: { ipv: { min: 2 }, hepb: { min: 2 } } },
  { ageMonths: 7,  req: { dtap: { min: 3 }, ipv: { min: 2 }, hib: { min: 2, max: 3 }, hepb: { min: 2 }, pcv: { min: 3 } } },
  { ageMonths: 12, req: { dtap: { min: 3 }, ipv: { min: 2 }, hib: { min: 2, max: 3 }, hepb: { min: 2 }, pcv: { min: 3 } } },
  { ageMonths: 16, req: { dtap: { min: 3 }, ipv: { min: 2 }, mmr: { min: 1 }, hib: { min: 3, max: 4 }, hepb: { min: 2 }, pcv: { min: 4 } } },
  { ageMonths: 19, req: { dtap: { min: 4 }, ipv: { min: 3 }, mmr: { min: 1 }, hib: { min: 3, max: 4 }, hepb: { min: 3 }, pcv: { min: 4 }, var: { min: 1 } } },
  { ageMonths: 48, req: { dtap: { min: 4 }, ipv: { min: 3 }, mmr: { min: 1 }, hib: { min: 3, max: 4 }, hepb: { min: 3 }, pcv: { min: 4 }, var: { min: 1 } } },
];

// CONDITIONAL RULES TO CONFIRM against MCS's formal NC sheet (10A NCAC
// 41A .0401) before reports are filed:
//   - DTaP: 4 doses suffice if dose #4 was on/after the 4th birthday.
//   - Polio: 3 doses suffice if dose #3 was on/after the 4th birthday.
//   - Hib/PCV: not required after the 5th birthday (handled via dropsAfterAge5).
//   - Hib count is brand-dependent (3 PedvaxHIB = 4 equivalent).
// These are encoded as TODO refinements; the min counts above are the
// conservative default until Mara confirms.
export const CONDITIONAL_RULES_PENDING_SIGNOFF = true;

// ── Per-dose status vocabulary (mirrors Transparent Classroom) ────────
export type DoseStatus =
  | 'done'          // ✓ recorded/received
  | 'near_due'      // ! coming up due soon
  | 'overdue'       // ✗ past due, not received
  | 'not_applicable'// na not required for this child (e.g. Hib after age 5)
  | 'exempt'        // e medical/religious exemption
  | 'upcoming';     // - not yet due (future dose)

// Days before a dose's due date that we start showing "near due".
export const NEAR_DUE_WINDOW_DAYS = 60;

// Whole months between two dates (for age math).
export function monthsBetween(from: Date, to: Date): number {
  return (to.getFullYear() - from.getFullYear()) * 12
    + (to.getMonth() - from.getMonth())
    - (to.getDate() < from.getDate() ? 1 : 0);
}

export function ageInMonths(dob: Date, asOf: Date): number {
  return Math.max(0, monthsBetween(dob, asOf));
}

// Resolve the requirement set that applies to a student right now: their
// report context, but for child-care kids stepped down to their age rung.
export function requirementForStudent(ctx: ReportContext, ageMonths: number): RequirementSet {
  if (ctx !== 'child_care') return REQUIRED_BY_CONTEXT[ctx];
  // child care: take the highest ladder rung the child has reached
  let req: RequirementSet = {};
  for (const rung of BY_AGE_LADDER) {
    if (ageMonths >= rung.ageMonths) req = rung.req;
  }
  return req;
}
