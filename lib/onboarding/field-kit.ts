// The Growth Suite Field Kit as code — the canonical custom-field + tag set
// for a new school's GHL location (docs/ghl-field-kit.md is the prose
// version). scripts/provision-field-kit.ts creates all of this via the API
// against a fresh location, so the "snapshot" can be rebuilt from source.
//
// Structure is standardized; VALUE vocabularies (grades, classrooms,
// programs, schedules) are per-school and filled at intake — picklists here
// ship with a PLACEHOLDER option that intake replaces.

export interface KitField {
  name: string;                       // GHL derives fieldKey from this
  dataType: 'TEXT' | 'LARGE_TEXT' | 'PHONE' | 'DATE' | 'MONETORY' | 'SINGLE_OPTIONS';
  options?: string[];                 // SINGLE_OPTIONS values
  folder: string;                     // logical grouping (created as field folders)
}

export const ENROLLMENT_STATUS_OPTIONS = [
  'Enrolled', 'Pending', 'Accepted', 'Waitlisted', 'Withdrawn', 'Declined',
];

// Placeholder for per-school vocabularies — replaced during intake.
const INTAKE = ['Set at intake'];

export const RESERVED_TAGS = ['parent 1', 'parent 2', 'withdrawn'];

export const MAX_SLOTS = 4;

function slotFields(n: number): KitField[] {
  const s = (base: string) => `Student ${n} ${base}`;
  const folder = `Student ${n}`;
  return [
    { name: s('First Name'), dataType: 'TEXT', folder },
    { name: s('Last Name'), dataType: 'TEXT', folder },
    { name: s('Enrollment Status'), dataType: 'SINGLE_OPTIONS', options: ENROLLMENT_STATUS_OPTIONS, folder },
    { name: s('Birth Date'), dataType: 'DATE', folder },
    { name: s('Grade Level'), dataType: 'SINGLE_OPTIONS', options: INTAKE, folder },
    { name: s('Program Name'), dataType: 'SINGLE_OPTIONS', options: INTAKE, folder },
    { name: s('Homeroom'), dataType: 'SINGLE_OPTIONS', options: INTAKE, folder },
    { name: s('Lead Teacher'), dataType: 'TEXT', folder },
    { name: s('Daily Schedule'), dataType: 'SINGLE_OPTIONS', options: INTAKE, folder },
    { name: s('Student ID'), dataType: 'TEXT', folder },
    { name: s('Gender'), dataType: 'SINGLE_OPTIONS', options: ['F', 'M', 'Other'], folder },
    { name: s('Allergies'), dataType: 'LARGE_TEXT', folder },
    { name: s('Enrollment Start Date'), dataType: 'DATE', folder },
    { name: s('Student Street'), dataType: 'TEXT', folder },
    { name: s('Student City'), dataType: 'TEXT', folder },
    { name: s('Student State'), dataType: 'TEXT', folder },
    { name: s('Student Zip'), dataType: 'TEXT', folder },
    { name: s('Ethnicity'), dataType: 'SINGLE_OPTIONS', options: INTAKE, folder },
    { name: s('Physical Custody'), dataType: 'SINGLE_OPTIONS', options: ['Both Mother and Father', 'Mother', 'Father', 'Other'], folder },
    { name: s('Physical Custody Oth'), dataType: 'TEXT', folder },
    { name: s('Legal Authority'), dataType: 'SINGLE_OPTIONS', options: [
      'Parents/Guardians share joint LDMA (married)',
      'Parents/Guardians share joint LDMA (unmarried)',
      'Parent/Guardian 1 has sole LDMA',
      'Other',
    ], folder },
    { name: s('Legal Authority Oth'), dataType: 'TEXT', folder },
    // Money / selections (Finance dashboard + enrollment writeback targets)
    { name: s('Annual Tuition'), dataType: 'MONETORY', folder },
    { name: s('Program Tuition Choice'), dataType: 'SINGLE_OPTIONS', options: INTAKE, folder },
    { name: s('Extended Day'), dataType: 'MONETORY', folder },
    { name: s('Extended Day Choice'), dataType: 'SINGLE_OPTIONS', options: INTAKE, folder },
    { name: s('Organic Lunch'), dataType: 'MONETORY', folder },
    { name: s('Organic Lunch Choice'), dataType: 'SINGLE_OPTIONS', options: INTAKE, folder },
    { name: s('Payment Plan'), dataType: 'SINGLE_OPTIONS', options: INTAKE, folder },
    { name: s('Enrollment Fee'), dataType: 'MONETORY', folder },
    { name: s('Administrative Fee'), dataType: 'MONETORY', folder },
    { name: s('Sibling Discount'), dataType: 'MONETORY', folder },
    { name: s('Total Charges'), dataType: 'MONETORY', folder },
    { name: s('Net Charges'), dataType: 'MONETORY', folder },
  ];
}

const parentFields: KitField[] = [
  { name: 'Parent 1 Relationship', dataType: 'TEXT', folder: 'Parents' },
  { name: 'Parent 1 Employer Name', dataType: 'TEXT', folder: 'Parents' },
  { name: 'Parent 1 Position', dataType: 'TEXT', folder: 'Parents' },
  { name: 'Parent 2 First Name', dataType: 'TEXT', folder: 'Parents' },
  { name: 'Parent 2 Last Name', dataType: 'TEXT', folder: 'Parents' },
  { name: 'Parent 2 Relationship', dataType: 'TEXT', folder: 'Parents' },
  { name: 'Parent 2 Email', dataType: 'TEXT', folder: 'Parents' },
  { name: 'Parent 2 Mobile', dataType: 'PHONE', folder: 'Parents' },
  { name: 'Parent 2 Address', dataType: 'TEXT', folder: 'Parents' },
  { name: 'Parent 2 City', dataType: 'TEXT', folder: 'Parents' },
  { name: 'Parent 2 State', dataType: 'TEXT', folder: 'Parents' },
  { name: 'Parent 2 Zip', dataType: 'TEXT', folder: 'Parents' },
  { name: 'Parent 2 Employer Name', dataType: 'TEXT', folder: 'Parents' },
  { name: 'Parent 2 Position', dataType: 'TEXT', folder: 'Parents' },
];

export function buildFieldKit(slots: number = MAX_SLOTS): KitField[] {
  const out: KitField[] = [];
  for (let n = 1; n <= slots; n++) out.push(...slotFields(n));
  out.push(...parentFields);
  return out;
}
