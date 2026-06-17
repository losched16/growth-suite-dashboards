// Seed 8 parent-portal form definitions for Montessori Children's School (MCS).
//
// School: Montessori Children's School (Jacksonville, NC)
//   school_id        a8b6674a-2515-4f2e-9897-73a968de7fe1
//   ghl_location_id  VwZSwFD2tkibAXbFZpQm
//
// Source PDFs: ../../MCSJAX-forms (extracted with pdfplumber). Content of
// every form below is transcribed from the actual MCS PDFs, with the
// usual portal adaptations:
//   - The parent already authenticates + (for per-student forms) picks a
//     child, so name/DOB/address fields PREFILL from student/parent/health
//     data wherever the field type supports it (see lib/forms/prefill.ts).
//   - Yes/No questions become radio groups; multi-line write-in answers
//     become textareas; signatures become signature_typed blocks.
//   - Health-relevant answers are keyed with the EXACT health-profile field
//     names (allergies / current_medications / medical_conditions /
//     primary_doctor_* / preferred_hospital / health_insurance_* /
//     emergency_contact_*). The submit route (app/api/portal-forms/submit
//     step 8 + HEALTH_PROFILE_FIELDS) writes those back to
//     student_health_profiles automatically by key match — NO ghl_writeback
//     entry is needed for the health profile sync.
//
// field_schema shape: array of discriminated-union blocks defined in the
// parent portal's lib/forms/types.ts and rendered by
// app/(portal)/forms-v2/[slug]/FormRenderer.tsx (BlockRenderer switch).
// Every block type used here (header, paragraph, section, text, email, tel,
// textarea, radio, checkbox, multi_checkbox, date, file_upload,
// signature_typed) has a matching renderer case + submit-route coercion.
//
// Upsert is idempotent: ON CONFLICT (school_id, slug) DO UPDATE. Mirrors the
// pattern in scripts/seed-dgm-forms-from-brief.mjs and
// scripts/seed-wooster-portal-forms.mjs.
//
// Usage:
//   node scripts/seed-mcs-forms.mjs
//   node scripts/seed-mcs-forms.mjs --school-id <uuid>
//
// Branding rule: never surface "GHL" / "GoHighLevel" in any parent-facing
// label or copy — the platform is "Growth Suite".

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// ── .env.local loader (same pattern as the other seed scripts) ───────────
const envText = readFileSync(join(projectRoot, '.env.local'), 'utf8');
for (const line of envText.split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('=');
  if (eq === -1) continue;
  const k = t.slice(0, eq).trim();
  if (!process.env[k]) process.env[k] = t.slice(eq + 1).trim();
}

function parseArgs(argv) {
  const out = { schoolId: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--school-id') out.schoolId = argv[++i];
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));

const DEFAULT_MCS_SCHOOL_ID = 'a8b6674a-2515-4f2e-9897-73a968de7fe1';
const schoolId = args.schoolId || DEFAULT_MCS_SCHOOL_ID;

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ─────────────────────────────────────────────────────────────────────────
// Field-block helpers
// ─────────────────────────────────────────────────────────────────────────
const header = (text) => ({ type: 'header', text });
const para = (text, emphasis) => (emphasis ? { type: 'paragraph', text, emphasis } : { type: 'paragraph', text });
const section = (label, description) => (description ? { type: 'section', label, description } : { type: 'section', label });
const txt = (key, label, opts = {}) => ({ type: 'text', key, label, ...opts });
const email = (key, label, opts = {}) => ({ type: 'email', key, label, ...opts });
const tel = (key, label, opts = {}) => ({ type: 'tel', key, label, ...opts });
const area = (key, label, opts = {}) => ({ type: 'textarea', key, label, rows: 3, ...opts });
const dateF = (key, label, opts = {}) => ({ type: 'date', key, label, ...opts });
const fileF = (key, label, opts = {}) => ({ type: 'file_upload', key, label, max_size_mb: 10, ...opts });
const checkboxF = (key, label, opts = {}) => ({ type: 'checkbox', key, label, ...opts });
const radioF = (key, label, options, opts = {}) => ({
  type: 'radio', key, label,
  options: options.map((o) => (typeof o === 'string' ? { value: keyify(o), label: o } : o)),
  ...opts,
});
function keyify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
}

// Reusable typed-signature + date pair. MCS forms are signed by the
// parent/guardian; several forms call for TWO parent signatures.
function parentSignature(key, label, opts = {}) {
  return {
    type: 'signature_typed',
    key,
    label,
    acknowledgment: opts.acknowledgment,
    required: opts.required !== false,
  };
}
const yesNo = (key, label, opts = {}) =>
  radioF(key, label, [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }], opts);

// MCS-standard e-signature consent text (Growth Suite branding).
const MCS_ESIG = 'By typing my full name below I am electronically signing this form and '
  + 'affirming that the information I have provided is accurate and complete.';

// ─────────────────────────────────────────────────────────────────────────
// FORM 1 — Contact Information & Pick-Up Authorization (per FAMILY, annual)
// ─────────────────────────────────────────────────────────────────────────
function buildContactInfoPickup() {
  const pickupSlot = (n, required) => [
    section(`Authorized pick-up person ${n}`),
    txt(`pickup${n}_name`, 'Name', { required, width: 'half' }),
    tel(`pickup${n}_phone`, 'Phone number', { required, width: 'half' }),
    txt(`pickup${n}_address`, 'Address', { required, width: 'full' }),
    txt(`pickup${n}_relationship`, 'Relationship to student', { required, width: 'half' }),
  ];

  const field_schema = [
    header('Contact Information & Pick-Up Authorization'),
    para('This form is completed upon enrollment and updated annually with a parent/guardian signature.', 'note'),

    section('Student information'),
    // Single-student family-level form: there is no student picker, so we
    // leave the child's name as a plain text field (no prefill — a family
    // may have multiple children but this is one shared contact record).
    txt('child_name', "Child's name", { required: true, width: 'half' }),
    dateF('child_dob', 'Date of birth', { required: true, width: 'half' }),
    txt('child_age', 'Age', { required: false, width: 'third' }),

    section('Current mailing address'),
    txt('mailing_street', 'Street address', { required: true, width: 'full' }),
    txt('mailing_city', 'City', { required: true, width: 'third' }),
    txt('mailing_state', 'State', { required: true, width: 'third' }),
    txt('mailing_zip', 'Zip code', { required: true, width: 'third' }),

    section('Messaging system contacts',
      'Used for our school-wide emergency and informational broadcast messages.'),
    tel('primary_contact_number', 'Primary contact number', { required: true, prefill: 'parent.phone', width: 'half' }),
    radioF('primary_contact_type', 'Primary number type', ['Cell', 'Home'], { required: true, width: 'half' }),
    tel('secondary_contact_number', 'Secondary contact number', { required: false, width: 'half' }),
    radioF('secondary_contact_type', 'Secondary number type', ['Cell', 'Home'], { required: false, width: 'half' }),

    section('Email addresses',
      'Used for communications from the School and your classroom Directress/Guide.'),
    email('primary_email', 'Primary email address', { required: true, prefill: 'parent.email', width: 'half' }),
    email('secondary_email', 'Secondary email address', { required: false, width: 'half' }),

    section('Parent 1 / Guardian'),
    txt('parent1_name', 'Parent 1 / Guardian name', { required: true, prefill: 'parent.full_name', width: 'half' }),
    txt('parent1_occupation', 'Occupation', { required: false, width: 'half' }),
    txt('parent1_address_if_different', 'Address (if different from student)', { required: false, width: 'full' }),
    txt('parent1_employer', 'Place of employment', { required: false, width: 'half' }),
    tel('parent1_work_phone', 'Work phone number', { required: false, width: 'half' }),
    tel('parent1_primary_contact', 'Primary contact number', { required: false, width: 'half' }),
    tel('parent1_secondary_contact', 'Secondary contact number', { required: false, width: 'half' }),

    section('Parent 2 / Guardian'),
    txt('parent2_name', 'Parent 2 / Guardian name', { required: false, width: 'half' }),
    txt('parent2_occupation', 'Occupation', { required: false, width: 'half' }),
    txt('parent2_address_if_different', 'Address (if different from student)', { required: false, width: 'full' }),
    txt('parent2_employer', 'Place of employment', { required: false, width: 'half' }),
    tel('parent2_work_phone', 'Work phone number', { required: false, width: 'half' }),
    tel('parent2_primary_contact', 'Primary contact number', { required: false, width: 'half' }),
    tel('parent2_secondary_contact', 'Secondary contact number', { required: false, width: 'half' }),

    section('Pick-up authorization',
      'These individuals are authorized to pick up your student from MCS in any non-emergency '
      + 'situation. Anyone on this list MUST present picture ID when arriving for pick-up.'),
    ...pickupSlot(1, true),
    ...pickupSlot(2, false),
    ...pickupSlot(3, false),
    ...pickupSlot(4, false),
    ...pickupSlot(5, false),
    ...pickupSlot(6, false),

    section('Parent / guardian signatures'),
    parentSignature('parent1_signature', 'Parent / Guardian 1 signature (type your full name)',
      { acknowledgment: MCS_ESIG, required: true }),
    dateF('parent1_signed_date', 'Date', { required: true, prefill: 'today', width: 'half' }),
    parentSignature('parent2_signature', 'Parent / Guardian 2 signature (type your full name)',
      { required: false }),
    dateF('parent2_signed_date', 'Date', { required: false, prefill: 'today', width: 'half' }),
  ];

  return {
    slug: 'contact-info-pickup',
    display_name: 'Contact Information & Pick-Up Authorization',
    description: 'Your family\'s contact details and the list of people authorized to pick up your '
      + 'student. Completed at enrollment and updated each year.',
    category: 'registration',
    per_student: false,
    one_submission_per_year: true,
    resubmission_allowed: true,
    allow_addendum: true,
    field_schema,
    ghl_writeback: [],
    confirmation_message: 'Thanks! Your contact information and pick-up authorization are on file with the office.',
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Shared builder for the two Student Personal Record forms (#2 and #3).
// `includePrimaryOnly` adds the Children's-House-only toileting + pacifier
// questions. Elementary omits them per the brief.
// ─────────────────────────────────────────────────────────────────────────
function buildStudentRecord({ slug, displayName, description, includePrimaryOnly }) {
  const siblingSlot = (n) => [
    txt(`sibling${n}_name`, `Sibling ${n} — name`, { required: false, width: 'third' }),
    txt(`sibling${n}_age`, `Sibling ${n} — age`, { required: false, width: 'third' }),
    txt(`sibling${n}_school`, `Sibling ${n} — school`, { required: false, width: 'third' }),
  ];

  const field_schema = [
    header(displayName),

    section('Student information'),
    // per_student form → child fields prefill from the selected student.
    txt('child_name', "Child's name", { required: true, prefill: 'student.full_name', width: 'half' }),
    txt('nickname', 'Nickname (if any)', { required: false, width: 'half' }),
    dateF('birth_date', 'Birth date', { required: true, prefill: 'student.date_of_birth', width: 'half' }),
    txt('age', 'Age', { required: false, width: 'third' }),
    tel('primary_contact_number', 'Primary contact #', { required: true, prefill: 'parent.phone', width: 'half' }),

    section('Family'),
    txt('parent1_name', 'Parent 1 / Guardian name', { required: true, prefill: 'parent.full_name', width: 'half' }),
    txt('parent2_name', 'Parent 2 / Guardian name', { required: false, width: 'half' }),
    txt('home_street', 'Street address', { required: true, width: 'full' }),
    txt('home_city', 'City', { required: true, width: 'third' }),
    txt('home_state', 'State', { required: true, width: 'third' }),
    txt('home_zip', 'Zip code', { required: true, width: 'third' }),

    section('Siblings', 'List any siblings (leave blank if none).'),
    ...siblingSlot(1),
    ...siblingSlot(2),
    ...siblingSlot(3),
    ...siblingSlot(4),

    section('Military affiliation'),
    yesNo('military_affiliated', 'Is your family military affiliated?', { required: true }),
    radioF('military_status', 'If yes, status', ['Veteran', 'Active Duty', 'Reserves'],
      { required: false, help: 'Only complete if you answered Yes above.' }),
    txt('military_branch', 'Branch affiliation', { required: false, help: 'Only complete if military affiliated.' }),

    section('Household'),
    radioF('resides_with', 'Child resides with',
      ['Both Parents', 'Mother', 'Father', 'Other'], { required: true }),
    txt('resides_with_other', 'If "Other", please specify', { required: false, width: 'full' }),
    txt('languages_spoken', 'Language(s) spoken at home', { required: false, width: 'full' }),
    area('home_health_problems', 'List any health problems and/or disabilities of those living in the home', { required: false }),

    section('About your child'),
    ...(includePrimaryOnly
      ? [
          yesNo('toilet_trained', 'Child is toilet trained', { required: true }),
          txt('toilet_phrase', 'What does your child say when he/she needs to use the toilet?', { required: false, width: 'full' }),
          area('toileting_help', 'Does your child need help using the toilet, dressing, undressing, eating, or washing hands?', { required: false }),
        ]
      : []),
    area('fears_or_problems', 'Does your child have any fears or problems of which his/her teacher should be aware?', { required: false }),
    yesNo('has_pets', 'Does your child have any pets at home?', { required: false }),
    txt('pets_kind', 'If yes, please list what kind', { required: false, width: 'full', help: 'Only complete if you answered Yes above.' }),
    area('favorite_activities', includePrimaryOnly
      ? "What are your child's favorite games, toys, and activities?"
      : "What are your child's favorite games and activities?", { required: false }),
    area('montessori_knowledge', 'What do you know about the Montessori method?', { required: false }),
    area('montessori_expectations', 'What do you expect from a Montessori education for your child?', { required: false }),
    area('discipline_approach', 'What is your approach to discipline?', { required: false }),

    section('Health & development history'),
    yesNo('behavioral_eval_history',
      'Has your child ever been evaluated, diagnosed, or treated for any behavioral, emotional, social, physical, or mental disability?',
      { required: true }),
    area('behavioral_eval_explain', 'If yes, please explain', { required: false, help: 'Only complete if you answered Yes above.' }),
    area('serious_injuries', 'List any serious injuries your child has had and the age at which they occurred', { required: false }),
    ...(includePrimaryOnly
      ? [area('pacifier_thumb', 'Does your child presently suck a pacifier, thumb, or fingers? Please describe.', { required: false })]
      : []),
    area('additional_comments',
      'If you have any additional comments or information that might help us understand your child better, '
      + "please share as much detail as possible about your child's personality, background, and history.",
      { required: false, rows: 5 }),

    section('Parent / guardian signature'),
    parentSignature('parent_signature', 'Parent / Guardian signature (type your full name)',
      { acknowledgment: MCS_ESIG, required: true }),
    dateF('signed_date', 'Date', { required: true, prefill: 'today', width: 'half' }),
  ];

  return {
    slug,
    display_name: displayName,
    description,
    category: 'registration',
    per_student: true,
    one_submission_per_year: true,
    resubmission_allowed: true,
    allow_addendum: false,
    field_schema,
    ghl_writeback: [],
    confirmation_message: 'Thanks! Your child\'s personal record is on file with the office.',
  };
}

// ─────────────────────────────────────────────────────────────────────────
// FORM 4 — Children's Medical Report (DCD 0108) (per STUDENT, annual)
// ─────────────────────────────────────────────────────────────────────────
function buildChildrensMedicalReport() {
  const field_schema = [
    header("Children's Medical Report (DCD 0108)"),
    para('Part A may be completed by a parent/guardian. Part B (the physical examination) must be '
      + 'completed and signed by a licensed physician — upload the signed page at the bottom of this form.', 'note'),

    section('Child information'),
    txt('child_name', 'Name of child', { required: true, prefill: 'student.full_name', width: 'half' }),
    dateF('birthdate', 'Birthdate', { required: true, prefill: 'student.date_of_birth', width: 'half' }),
    txt('parent_guardian_name', 'Name of parent or guardian', { required: true, prefill: 'parent.full_name', width: 'half' }),
    txt('parent_guardian_address', 'Address of parent or guardian', { required: true, width: 'full' }),

    section('A. Medical history', 'May be completed by parent.'),
    yesNo('allergic_any', 'Is the child allergic to anything?', { required: true }),
    // Keyed `allergies` so the submit route syncs it into the student
    // health profile (HEALTH_PROFILE_FIELDS). Subsequent medical/trip
    // forms then prefill from health.allergies.
    area('allergies', 'If yes, what is the child allergic to?', { required: false, help: 'Only complete if you answered Yes above.' }),
    yesNo('under_doctors_care', "Is the child currently under a doctor's care?", { required: true }),
    area('under_doctors_care_reason', 'If yes, for what reason?', { required: false, help: 'Only complete if you answered Yes above.' }),
    yesNo('continuous_medication', 'Is the child on any continuous medication?', { required: true }),
    // Keyed `current_medications` for health-profile writeback.
    area('current_medications', 'If yes, what medication?', { required: false, help: 'Only complete if you answered Yes above.' }),
    yesNo('prev_hospitalizations', 'Any previous hospitalizations or operations?', { required: true }),
    area('prev_hospitalizations_detail', 'If yes, when and for what?', { required: false, help: 'Only complete if you answered Yes above.' }),

    yesNo('significant_diseases', 'Any history of significant previous diseases or recurrent illness?', { required: true }),
    {
      type: 'multi_checkbox',
      key: 'disease_types',
      label: 'If yes, check all that apply',
      options: [
        { value: 'diabetes', label: 'Diabetes' },
        { value: 'convulsions', label: 'Convulsions' },
        { value: 'heart_trouble', label: 'Heart trouble' },
        { value: 'asthma', label: 'Asthma' },
      ],
      help: 'Only complete if you answered Yes above.',
    },
    txt('disease_other', 'If other diseases/illnesses, what and when?', { required: false, width: 'full' }),

    yesNo('physical_disabilities', 'Does the child have any physical disabilities?', { required: true }),
    area('physical_disabilities_describe', 'If yes, please describe', { required: false, help: 'Only complete if you answered Yes above.' }),
    yesNo('mental_disabilities', 'Any mental disabilities?', { required: true }),
    area('mental_disabilities_describe', 'If yes, please describe', { required: false, help: 'Only complete if you answered Yes above.' }),

    section('Parent / guardian signature (Part A)'),
    parentSignature('parent_signature', 'Parent / Guardian signature (type your full name)',
      { acknowledgment: MCS_ESIG, required: true }),
    dateF('parent_signed_date', 'Date', { required: true, prefill: 'today', width: 'half' }),

    section('B. Physical examination',
      'This examination must be completed and signed by a licensed physician (or an authorized agent '
      + 'approved by the N.C. Board of Medical Examiners or a comparable bordering-state board, a certified '
      + 'nurse practitioner, or a public health nurse meeting DHHS EPSDT standards).'),
    para('Download or print the DCD 0108 form, have your physician complete and sign Part B, then upload '
      + 'the completed, signed page here. Accepted formats: PDF, JPG, or PNG.', 'warning'),
    fileF('signed_dcd_0108', 'Completed & signed DCD 0108 (physician Part B)', {
      required: false,
      accept: 'application/pdf,image/jpeg,image/png',
      help: 'Upload the physician-signed medical report. Required by NC child care licensing before the child starts.',
    }),
  ];

  return {
    slug: 'childrens-medical-report',
    display_name: "Children's Medical Report (DCD 0108)",
    description: 'The North Carolina child-care medical report. Complete the medical history (Part A), sign, '
      + 'and upload your physician\'s completed and signed physical examination (Part B).',
    category: 'medical',
    per_student: true,
    one_submission_per_year: true,
    resubmission_allowed: true,
    allow_addendum: true,
    field_schema,
    ghl_writeback: [],
    confirmation_message: 'Thanks! Your child\'s medical report is on file. The office will follow up if the '
      + 'physician-signed Part B is still needed.',
  };
}

// ─────────────────────────────────────────────────────────────────────────
// FORM 5 — Emergency Medical Care Information & Authorization (per STUDENT, annual)
// ─────────────────────────────────────────────────────────────────────────
function buildEmergencyMedicalCare() {
  const ecSlot = (n, required) => [
    section(`Emergency contact ${n}`),
    txt(`ec${n}_name`, 'Name', { required, width: 'half' }),
    txt(`ec${n}_relationship`, 'Relationship', { required, width: 'half' }),
    tel(`ec${n}_home_phone`, 'Home phone', { required: false, width: 'third' }),
    tel(`ec${n}_work_phone`, 'Work phone', { required: false, width: 'third' }),
    tel(`ec${n}_cell_phone`, 'Cell phone', { required: false, width: 'third' }),
  ];

  const field_schema = [
    header('Emergency Medical Care Information & Authorization'),

    section('Student information'),
    txt('student_name', 'Student name', { required: true, prefill: 'student.full_name', width: 'half' }),
    txt('program', 'Program', { required: false, width: 'half' }),
    dateF('dob', 'Date of birth', { required: true, prefill: 'student.date_of_birth', width: 'half' }),

    section('Insurance & providers'),
    // health-profile-keyed fields prefill from + write back to the profile.
    txt('health_insurance_provider', 'Insurance provider', { required: false, prefill: 'health.health_insurance_provider', width: 'half' }),
    txt('health_insurance_policy_number', 'Policy / Social Security #', { required: false, prefill: 'health.health_insurance_policy_number', width: 'half' }),
    txt('primary_doctor_name', "Physician's name", { required: false, prefill: 'health.primary_doctor_name', width: 'half' }),
    tel('primary_doctor_phone', 'Physician phone', { required: false, prefill: 'health.primary_doctor_phone', width: 'half' }),
    txt('physician_address', 'Physician address', { required: false, width: 'full' }),
    txt('dentist_name', "Dentist's name", { required: false, width: 'half' }),
    tel('dentist_phone', 'Dentist phone', { required: false, width: 'half' }),
    txt('dentist_address', 'Dentist address', { required: false, width: 'full' }),
    txt('preferred_hospital', 'Hospital preference', { required: false, prefill: 'health.preferred_hospital', width: 'full' }),

    section('Health care needs',
      'For any child with health care needs such as allergies or chronic illnesses (asthma, diabetes, '
      + 'epilepsy) that require specialized services, a medical action plan should be attached to this form.'),
    yesNo('medical_action_plan_attached', 'Is a medical action plan attached?', { required: true }),
    area('allergies', 'List any allergies and the symptoms and type of response required for allergic reactions', { required: false }),
    area('medical_conditions', 'List any health care needs or concerns, symptoms, or type of response required', { required: false }),
    area('particular_fears_behaviors', 'List any particular fears or unique behavior characteristics the child has', { required: false }),
    area('current_medications', 'List any medication taken for health care needs', { required: false }),
    area('other_safe_treatment_info', 'Share any other information that has a direct bearing on assuring safe medical treatment for your child', { required: false }),

    section('Emergency medical care authorization',
      'In the event of a medical emergency or illness, the School will contact the parents/guardians first. '
      + 'If neither parent (or guardian) can be contacted, the individuals below are authorized to respond.'),
    ...ecSlot(1, true),
    ...ecSlot(2, false),
    ...ecSlot(3, false),

    section('Consent'),
    para('I hereby authorize the staff and/or Head of School at the Montessori Children\'s School, Inc. to '
      + 'give consent for any and all necessary emergency medical treatment for my child while my child is in '
      + 'the care and custody of the staff and/or Head of School at the Montessori Children\'s School.', 'note'),
    txt('child_name_consent', 'Child\'s name (for the authorization above)', { required: true, prefill: 'student.full_name', width: 'half' }),
    parentSignature('parent1_signature', 'Parent / Guardian 1 signature (type your full name)',
      { acknowledgment: MCS_ESIG, required: true }),
    dateF('parent1_signed_date', 'Date', { required: true, prefill: 'today', width: 'half' }),
    parentSignature('parent2_signature', 'Parent / Guardian 2 signature (type your full name)',
      { required: false }),
    dateF('parent2_signed_date', 'Date', { required: false, prefill: 'today', width: 'half' }),
  ];

  return {
    slug: 'emergency-medical-care',
    display_name: 'Emergency Medical Care Information & Authorization',
    description: 'Insurance, physician, dentist, and emergency-contact details, plus your authorization for '
      + 'the school to obtain emergency medical care for your child.',
    category: 'medical',
    per_student: true,
    one_submission_per_year: true,
    resubmission_allowed: true,
    allow_addendum: true,
    field_schema,
    ghl_writeback: [],
    confirmation_message: 'Thanks! Your child\'s emergency medical information and authorization are on file with the office.',
  };
}

// ─────────────────────────────────────────────────────────────────────────
// FORM 6 — Discipline & Behavior Management Policy (per FAMILY, read-and-sign)
// Policy text is verbatim from the MCS PDF (Revised 1/2024).
// ─────────────────────────────────────────────────────────────────────────
function buildDisciplinePolicy() {
  const field_schema = [
    header('Discipline & Behavior Management Policy'),

    para(
      'The Montessori Children’s School believes that each child is a unique person who deserves to be '
      + 'treated with the same dignity and respect that is given to the adult. We believe our role as educators '
      + 'is to create an atmosphere in which the child can feel confident, secure, and loved. We strive to meet '
      + 'the needs of the child for achievements, movement, approval, encouragement, independence, individuality, '
      + 'integrity, love, order, physical well-being and safety. We believe the child should be free to make '
      + 'choices and to assume the responsibilities which go with that freedom. Our ultimate goal is that of '
      + 'self-discipline and self-control of the individual child, which is achieved through work, concentration '
      + 'and freedom of choice (including the freedom to make mistakes). In a Montessori classroom, a child '
      + 'learns freedom and responsibility by assuming responsibility for their actions. If a child has done '
      + 'something for which there are direct consequences, he/she is instructed to assume responsibility (ex: '
      + 'clean up, if the child has written on the wall). If the child needs temporary assistance in managing his '
      + 'freedom of choice or movement, the child is given the assistance needed and then offered freedom as '
      + 'quickly as responsibility returns. We believe that the adult should always be an exemplary positive role '
      + 'model for the child to imitate. Our golden rule is “be gentle with your friends and with yourself”.',
    ),
    para(
      'Based on these principles, we intervene when:\n'
      + '1. The safety of the child or of other children is threatened,\n'
      + '2. The child does not respect another child or misuses material,\n'
      + '3. The child is not using appropriate language,\n'
      + '4. The child is in any way disruptive to an atmosphere that is conducive to learning.',
    ),
    para(
      'In the case of misbehavior:\n'
      + '1. We express our disapproval of the behavior in a way that invites growth and learning: “I am sorry '
      + 'he/she did that, he/she will learn not to do that.”\n'
      + '2. We direct or refocus the attention of the child, either by leading him/her to another activity or '
      + 'giving him/her a choice.\n'
      + '3. We inform the parent(s) or guardian(s) of any recurrent discipline problem and have a conference with '
      + 'them in which guidelines are set up.\n'
      + '4. We instruct children to use assertive behavior to learn skills to cope with inappropriate behavior '
      + 'from their peers.\n'
      + '5. We limit the use of rewards.\n'
      + '6. We do not in any way or manner use physical force, punish, coerce, manipulate, shame, verbally abuse, '
      + 'or attack the dignity and integrity of the child.',
    ),

    section('Parent / guardian acknowledgment'),
    txt('child_full_name', "Child's full name", { required: true, width: 'full' }),
    para(
      'I, the undersigned parent or guardian of the child named above, do hereby state that I have read and '
      + 'received a copy of the facility’s Discipline and Behavior Management Policy and that the facility’s '
      + 'director/operator (or other designated staff member) has discussed the facility’s Discipline and '
      + 'Behavior Management Policy with me.', 'note',
    ),
    parentSignature('parent_signature', 'Parent / Guardian signature (type your full name)',
      {
        acknowledgment: 'By typing my full name below I acknowledge that I have read, received a copy of, and '
          + 'discussed the Discipline and Behavior Management Policy with MCS staff.',
        required: true,
      }),
    dateF('signed_date', 'Date', { required: true, prefill: 'today', width: 'half' }),
  ];

  return {
    slug: 'discipline-behavior-policy',
    display_name: 'Discipline & Behavior Management Policy',
    description: 'Please read the MCS Discipline and Behavior Management Policy and sign to acknowledge that '
      + 'you have received and discussed it.',
    category: 'release',
    per_student: false,
    one_submission_per_year: true,
    resubmission_allowed: true,
    allow_addendum: false,
    field_schema,
    ghl_writeback: [],
    confirmation_message: 'Thank you for acknowledging the Discipline & Behavior Management Policy. Your signed acknowledgment is on file.',
  };
}

// ─────────────────────────────────────────────────────────────────────────
// FORM 7 — Permission Agreement (per STUDENT)
// ─────────────────────────────────────────────────────────────────────────
function buildPermissionAgreement() {
  const grantDeny = (key, label) =>
    radioF(key, label, [{ value: 'granted', label: 'Granted' }, { value: 'denied', label: 'Denied' }], { required: true });

  const field_schema = [
    header('Permission Agreement'),
    txt('student_name', "Student's name", { required: true, prefill: 'student.full_name', width: 'half' }),

    section('Permissions',
      'Please indicate whether permission is granted or denied for each of the following.'),
    grantDeny('permission_offcampus',
      'Permission for my child to participate in supervised school activities outside the fenced areas of the '
      + 'school campus grounds, such as fire truck visits or nature walks. (Prior notification of any off-campus '
      + 'field trips will be sent home with my child stating departure and return times.)'),
    grantDeny('permission_promo_literature',
      'Permission for photographs of my child to be used in any form of literature for MCS promotional '
      + 'publications distributed outside the School.'),
    grantDeny('permission_yearbook',
      'Permission for photographs of my child to be published in our school yearbook.'),
    grantDeny('permission_social_media',
      'Permission for photographs of my child to be used in any form on social media (Facebook, Instagram, etc.).'),

    para('If permission is denied for any of the above provisions, such denial will remain in effect and will be '
      + 'contained in the student’s record until the parent or guardian provides a letter expressly revoking '
      + 'the denial and granting permission.', 'note'),
    area('denial_reason', 'If permission is denied, please state the reason', { required: false }),

    section('Parent / guardian signatures'),
    parentSignature('parent1_signature', 'Parent / Guardian 1 signature (type your full name)',
      { acknowledgment: MCS_ESIG, required: true }),
    dateF('parent1_signed_date', 'Date', { required: true, prefill: 'today', width: 'half' }),
    parentSignature('parent2_signature', 'Parent / Guardian 2 signature (type your full name)',
      { required: false }),
    dateF('parent2_signed_date', 'Date', { required: false, prefill: 'today', width: 'half' }),
  ];

  return {
    slug: 'permission-agreement',
    display_name: 'Permission Agreement',
    description: 'Your photo and off-campus activity permissions for your child. Each item can be granted or denied.',
    category: 'permission',
    per_student: true,
    one_submission_per_year: true,
    resubmission_allowed: true,
    allow_addendum: false,
    field_schema,
    ghl_writeback: [],
    confirmation_message: 'Thanks! Your permission selections are on file with the office.',
  };
}

// ─────────────────────────────────────────────────────────────────────────
// FORM 8 — Bulk Milk & Hot Foods Acknowledgment (per FAMILY, NC regulatory)
// ─────────────────────────────────────────────────────────────────────────
function buildBulkMilkHotFoods() {
  const field_schema = [
    header('Bulk Milk & Hot Foods Acknowledgment'),
    para('Child Care Food Requirements — North Carolina', 'note'),

    section('Bulk Specialty Milk', '15A NCAC 18A .2806'),
    para(
      'Due to dietary restrictions, I will provide my child with a specialty bulk milk at the beginning of each '
      + 'week, unopened and labeled with the date received and the child’s name. Any remaining bulk specialty '
      + 'milk will be sent home at the end of the week. Please check N/A below if this does not apply to your child.',
    ),
    checkboxF('bulk_milk_na', 'N/A — bulk specialty milk does not apply to my child',
      { required: false, help: 'Leave unchecked if you will be providing bulk specialty milk.' }),
    txt('bulk_milk_initial', 'Initial here to acknowledge the bulk specialty milk requirement (or if you will provide it)',
      { required: false, width: 'third', max_length: 5 }),

    section('Hot Foods', '15A NCAC 18A .2804'),
    para('I acknowledge that hot foods must be brought in a double-walled, insulated thermos container.'),
    checkboxF('hot_foods_ack', 'I acknowledge the hot foods requirement', { required: true }),

    section('Acknowledgment & signature'),
    para('This document serves as my written permission, understanding, and acknowledgment of these requirements.', 'note'),
    txt('child_name', "Child's name", { required: true, width: 'half' }),
    txt('parent_name_printed', 'Parent / Guardian name (printed)', { required: true, prefill: 'parent.full_name', width: 'half' }),
    parentSignature('parent_signature', 'Parent / Guardian signature (type your full name)',
      {
        acknowledgment: 'By typing my full name below I provide my written permission, understanding, and '
          + 'acknowledgment of the bulk specialty milk and hot foods requirements above.',
        required: true,
      }),
    dateF('signed_date', 'Date', { required: true, prefill: 'today', width: 'half' }),
  ];

  return {
    slug: 'bulk-milk-hot-foods',
    display_name: 'Bulk Milk & Hot Foods Acknowledgment',
    description: 'North Carolina child-care food requirements for bulk specialty milk (15A NCAC 18A .2806) and '
      + 'hot foods (15A NCAC 18A .2804). Please acknowledge and sign.',
    category: 'release',
    per_student: false,
    one_submission_per_year: true,
    resubmission_allowed: true,
    allow_addendum: false,
    field_schema,
    ghl_writeback: [],
    confirmation_message: 'Thanks! Your bulk milk & hot foods acknowledgment is on file with the office.',
  };
}

// ─────────────────────────────────────────────────────────────────────────
// The 8 forms
// ─────────────────────────────────────────────────────────────────────────
const FORMS = [
  buildContactInfoPickup(),
  buildStudentRecord({
    slug: 'student-record-childrens-house',
    displayName: "Student Personal Record — Children's House",
    description: "Your child's personal record for the Children's House (Primary or Stepping Stones) program.",
    includePrimaryOnly: true,
  }),
  buildStudentRecord({
    slug: 'student-record-elementary',
    displayName: 'Elementary Student Personal Record',
    description: "Your child's personal record for the Elementary program.",
    includePrimaryOnly: false,
  }),
  buildChildrensMedicalReport(),
  buildEmergencyMedicalCare(),
  buildDisciplinePolicy(),
  buildPermissionAgreement(),
  buildBulkMilkHotFoods(),
];

// ─────────────────────────────────────────────────────────────────────────
// Upsert
// ─────────────────────────────────────────────────────────────────────────
const UPSERT_SQL = `
  INSERT INTO portal_form_definitions
    (school_id, slug, display_name, description, category, per_student,
     required_for, is_active, field_schema, ghl_writeback,
     one_submission_per_year, resubmission_allowed, needs_review,
     allow_addendum, confirmation_message)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15)
  ON CONFLICT (school_id, slug) DO UPDATE SET
     display_name           = EXCLUDED.display_name,
     description            = EXCLUDED.description,
     category               = EXCLUDED.category,
     per_student            = EXCLUDED.per_student,
     required_for           = EXCLUDED.required_for,
     is_active              = EXCLUDED.is_active,
     field_schema           = EXCLUDED.field_schema,
     ghl_writeback          = EXCLUDED.ghl_writeback,
     one_submission_per_year= EXCLUDED.one_submission_per_year,
     resubmission_allowed   = EXCLUDED.resubmission_allowed,
     needs_review           = EXCLUDED.needs_review,
     allow_addendum         = EXCLUDED.allow_addendum,
     confirmation_message   = EXCLUDED.confirmation_message,
     updated_at             = now()
  RETURNING (xmax = 0) AS inserted`;

function countFields(schema) {
  return schema.filter((b) => 'key' in b).length;
}

async function main() {
  const sRes = await pool.query(
    `SELECT id, name, ghl_location_id FROM schools WHERE id = $1`, [schoolId],
  );
  if (sRes.rowCount === 0) {
    console.error(`School ${schoolId} not found. Aborting (no rows written).`);
    process.exit(2);
  }
  console.log(`Seeding ${FORMS.length} portal forms for ${sRes.rows[0].name} (school_id=${schoolId})`);
  console.log('');

  let created = 0, updated = 0;
  for (const f of FORMS) {
    const res = await pool.query(UPSERT_SQL, [
      schoolId, f.slug, f.display_name, f.description, f.category, f.per_student,
      'all', true,
      JSON.stringify(f.field_schema), JSON.stringify(f.ghl_writeback ?? []),
      f.one_submission_per_year, f.resubmission_allowed, false,
      f.allow_addendum, f.confirmation_message ?? null,
    ]);
    const inserted = res.rows[0]?.inserted;
    if (inserted) { created++; console.log(`  + created ${f.slug}`); }
    else { updated++; console.log(`  ~ updated ${f.slug}`); }
  }

  console.log('');
  console.log(`Done. ${created} created, ${updated} updated.`);
  console.log('');

  // ── Verification ────────────────────────────────────────────────────────
  const verify = await pool.query(
    `SELECT slug, display_name, per_student, jsonb_array_length(field_schema) AS blocks,
            (SELECT COUNT(*) FROM jsonb_array_elements(field_schema) e WHERE e ? 'key') AS fields
       FROM portal_form_definitions
      WHERE school_id = $1 AND slug = ANY($2)
      ORDER BY slug`,
    [schoolId, FORMS.map((f) => f.slug)],
  );
  console.log('Verification (portal_form_definitions for MCS):');
  console.log('slug'.padEnd(34), 'per_student'.padEnd(12), 'fields'.padEnd(8), 'display_name');
  for (const r of verify.rows) {
    console.log(
      String(r.slug).padEnd(34),
      String(r.per_student).padEnd(12),
      String(r.fields).padEnd(8),
      r.display_name,
    );
  }
  console.log(`\n${verify.rowCount} of ${FORMS.length} forms present.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => pool.end());
