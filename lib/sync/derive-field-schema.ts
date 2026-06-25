// Data-driven field-schema derivation.
//
// Given the custom-field KEYS that exist on a GHL location, build that
// school's role→key map purely from what the location actually carries.
// Nothing about a specific school is hardcoded: the ROLES are universal
// (every school's students have a name, a program, a grade, etc.), and the
// concrete GHL key for each role is discovered from the location's fields.
// This is what lets the dashboard mirror whatever a school puts in GHL and
// lets any new school onboard the same way with no code per school.

import { parseStudentSlotKey } from './slot-keys';

// Universal student roles → candidate base keys, in priority order. The
// first variant actually present on the location wins. Add variants here
// (not per-school) when a new school names a field differently.
const STUDENT_ROLE_VARIANTS: Record<string, string[]> = {
  firstName: ['first_name'],
  lastName: ['last_name'],
  preferredName: ['preferred_name', 'nickname'],
  birthDate: ['birth_date', 'date_of_birth', 'dob'],
  gender: ['gender'],
  gradeLevel: ['grade_level', 'grade'],
  program: ['program', 'program_name'],
  homeroom: ['homeroom', 'classroom'],
  enrollmentStatus: ['enrollment_status', 'status'],
  initialStartDate: ['initial_start_date'],
  currentYearStartDate: ['current_year_enrollment_start_date', 'enrollment_start_date', 'start_date'],
  iep: ['iep'],
  fivelOFourPlan: ['504_plan', 'five04_plan'],
  dailySchedule: ['daily_schedule', 'schedule'],
  leadTeacher: ['lead_teacher', 'teacher'],
  allergy: ['allergy', 'allergies'],
};

// Parent-2 roles → candidate FULL keys (parent-2 fields aren't slot-scoped).
const PARENT2_ROLE_VARIANTS: Record<string, string[]> = {
  firstName: ['parent_2_first_name'],
  lastName: ['parent_2_last_name'],
  email: ['parent_2_email'],
  phone: ['parent_2_phone', 'parent_2_mobile'],
  homePhone: ['parent_2_home_phone'],
};

// Family/household roles → candidate FULL keys. Absent for one-contact-=-
// one-family schools (like a fresh import where each parent is a contact).
const FAMILY_ROLE_VARIANTS: Record<string, string[]> = {
  householdId: ['household_id'],
  householdPhone: ['household_phone'],
};

export interface DerivedFieldSchema {
  family_fields: Record<string, string>;
  parent2_fields: Record<string, string>;
  student_fields: Record<string, string>;
  max_student_slots: number;
  // True when the location groups multiple contacts into a household via a
  // household_id field; false when each contact is its own family.
  has_household: boolean;
}

// `keys` = every custom-field key on the location (with or without the
// leading `contact.` prefix — both are tolerated).
export function deriveFieldSchemaFromKeys(keys: string[]): DerivedFieldSchema {
  const norm = keys.map((k) => (k.startsWith('contact.') ? k.slice('contact.'.length) : k));
  const keySet = new Set(norm);

  // Student base keys present + max slot seen.
  const studentBases = new Set<string>();
  let maxSlot = 1;
  for (const k of norm) {
    const p = parseStudentSlotKey(k);
    if (!p) continue;
    studentBases.add(p.base);
    if (p.slot > maxSlot) maxSlot = p.slot;
  }

  const student_fields: Record<string, string> = {};
  for (const [role, variants] of Object.entries(STUDENT_ROLE_VARIANTS)) {
    const hit = variants.find((v) => studentBases.has(v));
    if (hit) student_fields[role] = hit;
  }

  const parent2_fields: Record<string, string> = {};
  for (const [role, variants] of Object.entries(PARENT2_ROLE_VARIANTS)) {
    const hit = variants.find((v) => keySet.has(v));
    if (hit) parent2_fields[role] = hit; // full key — parent-2 isn't slot-scoped
  }

  const family_fields: Record<string, string> = {};
  for (const [role, variants] of Object.entries(FAMILY_ROLE_VARIANTS)) {
    const hit = variants.find((v) => keySet.has(v));
    if (hit) family_fields[role] = hit;
  }

  return {
    family_fields,
    parent2_fields,
    student_fields,
    max_student_slots: Math.max(1, Math.min(maxSlot, 8)),
    has_household: !!family_fields.householdId,
  };
}
