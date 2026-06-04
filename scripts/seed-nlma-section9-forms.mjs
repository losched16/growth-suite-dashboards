// Seed NLMA Section 9 parent forms (9 forms from the Family Forms doc).
//
// All 9 forms are seeded as DRAFTS (is_active=false) so the school
// admin can review/edit each one before publishing. They appear in
// the admin Forms tab under "Drafts — hidden from parents".
//
// Form structures derived from:
//   "Northern Lights Montessori Academy – Section 9 Family Forms.docx"
//
// Audience: 'parents'. Per-student forms use student_picker so the
// child's name + parents auto-attach on submission.
//
// Re-runnable: ON CONFLICT (school_id, slug) DO UPDATE refreshes the
// schema in place. Pass --refresh to overwrite even when needs_review
// is false (use after admin edits to force a reseed).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

const envText = readFileSync(join(projectRoot, '.env.local'), 'utf8');
for (const line of envText.split('\n')) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('='); if (eq === -1) continue;
  const k = t.slice(0, eq).trim();
  if (!process.env[k]) process.env[k] = t.slice(eq + 1).trim();
}

const NLMA_SCHOOL_ID = '2717d71b-aa80-4ca0-8a13-e81cace2d9c1';
const REFRESH = process.argv.includes('--refresh');

// ── block helpers ──────────────────────────────────────────────────
const header = (text) => ({ type: 'header', text });
const para = (text, emphasis) => emphasis ? { type: 'paragraph', text, emphasis } : { type: 'paragraph', text };
const section = (label) => ({ type: 'section', label });
const txt = (key, label, opts = {}) => ({ type: 'text', key, label, ...opts });
const area = (key, label, opts = {}) => ({ type: 'textarea', key, label, rows: opts.rows ?? 3, ...opts });
const email = (key, label, opts = {}) => ({ type: 'email', key, label, ...opts });
const phone = (key, label, opts = {}) => ({ type: 'tel', key, label, ...opts });
const date = (key, label, opts = {}) => ({ type: 'date', key, label, ...opts });
const select = (key, label, options, opts = {}) => ({
  type: 'select', key, label,
  options: options.map((v) => typeof v === 'string' ? { value: v, label: v } : v),
  ...opts,
});
const radio = (key, label, options, opts = {}) => ({
  type: 'radio', key, label,
  options: options.map((v) => typeof v === 'string' ? { value: v, label: v } : v),
  ...opts,
});
const check = (key, label, opts = {}) => ({ type: 'checkbox', key, label, ...opts });
const multi = (key, label, options, opts = {}) => ({
  type: 'multi_checkbox', key, label,
  options: options.map((v) => typeof v === 'string' ? { value: v.toLowerCase().replace(/[^a-z0-9]+/g, '_'), label: v } : v),
  ...opts,
});
const studentPicker = (opts = {}) => ({
  type: 'student_picker',
  key: 'child',
  label: opts.label ?? 'Select your child',
  required: opts.required ?? true,
  help: opts.help ?? 'We\'ll auto-attach your child\'s name + parent contacts to this submission.',
  ...opts,
});
const sign = (keyPrefix, signerLabel, opts = {}) => [
  txt(`${keyPrefix}_signature`, `${signerLabel} — typed full name (acts as signature)`, { required: opts.required ?? false }),
  date(`${keyPrefix}_signature_date`, `${signerLabel} — date signed`, { required: opts.required ?? false }),
];

const CLASSROOM_LEVELS = ['Early Childhood', 'Lower Elementary', 'Upper Elementary', 'Middle School'];

// ── Form 9.1 — Handbook Acknowledgment ─────────────────────────────
const F91 = {
  slug: 'nlma-handbook-acknowledgment',
  display_name: 'Form 9.1 — Handbook Acknowledgment & Agreement',
  description: 'Confirms you have received, read, and agree to the NLMA Parent & Family Handbook for the current school year.',
  category: 'legal',
  per_student: true,
  field_schema: [
    header('Handbook Acknowledgment & Agreement'),
    para('Welcome to the Northern Lights Montessori Academy family! This form confirms that you have received, read, and agree to abide by the guidelines and policies in the current edition of the NLMA Parent & Family Handbook. Both parents/guardians should sign where applicable.'),

    section('Student & Family Information'),
    studentPicker(),
    select('classroom_level', 'Classroom / Level', CLASSROOM_LEVELS, { required: true }),
    txt('parent_1_name', 'Parent / Guardian 1 — full name', { required: true }),
    txt('parent_2_name', 'Parent / Guardian 2 — full name (if applicable)'),
    txt('school_year', 'School year', { placeholder: 'e.g. 2026–2027', required: true }),

    section('Acknowledgment Checklist'),
    para('Please check each statement to confirm your understanding and agreement.'),
    check('ack_handbook_received', 'I have received and read the NLMA Parent & Family Handbook for the current school year.', { required: true }),
    check('ack_attendance', 'I understand and agree to the school\'s attendance and punctuality policies, including on-time arrival and timely pick-up.', { required: true }),
    check('ack_montessori_philosophy', 'I agree to support the Montessori philosophy at home — fostering independence, respect, and a love of learning.', { required: true }),
    check('ack_dropoff_pickup', 'I understand the school\'s drop-off and pick-up procedures and will follow them consistently for all children\'s safety.', { required: true }),
    check('ack_communication', 'I understand and agree to the communication expectations between families and staff.', { required: true }),
    check('ack_technology_policy', 'I understand the technology and personal device policies for students at NLMA.', { required: true }),
    check('ack_discipline', 'I understand the school\'s discipline and guidance philosophy.', { required: true }),
    check('ack_emergency_info', 'I agree to maintain current emergency contact information, medical information, and authorized pick-up lists with the office.', { required: true }),
    check('ack_media_release', 'I understand NLMA\'s media release and photography policies and have completed the Media Release Form (Form 9.2).', { required: true }),
    check('ack_financial', 'I understand the financial agreement and tuition payment policies, including due dates, late payment procedures, and the financial assistance application process.', { required: true }),
    check('ack_health_illness', 'I understand NLMA\'s health and illness policies, including the requirement to keep children home when symptomatic.', { required: true }),
    check('ack_volunteer', 'I understand NLMA\'s volunteer expectations and community participation opportunities.', { required: true }),

    section('Signatures'),
    ...sign('parent_1', 'Parent / Guardian 1', { required: true }),
    ...sign('parent_2', 'Parent / Guardian 2 (if applicable)'),
  ],
};

// ── Form 9.2 — Media Release ───────────────────────────────────────
const MEDIA_USE_OPTIONS = [
  { value: 'yes', label: 'Yes — I give permission' },
  { value: 'no',  label: 'No — I do not give permission' },
];
const F92 = {
  slug: 'nlma-media-release',
  display_name: 'Form 9.2 — Media Release Form',
  description: 'Permission for use of your child\'s image/likeness in various NLMA communications.',
  category: 'release',
  per_student: true,
  field_schema: [
    header('Media Release Form'),
    para('NLMA uses photography and video to document student learning and celebrate community events. Except where explicit written permission is granted below, student full names will not be published alongside photographs. Your preferences will be honored and kept on file for the current school year.'),

    section('Section A — Permission by Media Use Type'),
    radio('use_internal_only', 'Internal use only — classroom documentation, student portfolios, and in-school displays (not shared publicly)', MEDIA_USE_OPTIONS, { required: true }),
    radio('use_newsletter', 'School newsletter and printed communications distributed to NLMA families', MEDIA_USE_OPTIONS, { required: true }),
    radio('use_website', 'School website (nlmontessori.org or equivalent)', MEDIA_USE_OPTIONS, { required: true }),
    radio('use_social_media', 'School social media accounts (Facebook, Instagram, and other official NLMA platforms)', MEDIA_USE_OPTIONS, { required: true }),
    radio('use_local_news', 'Local newspaper, community publications, or media coverage of school events', MEDIA_USE_OPTIONS, { required: true }),
    radio('use_grants_marketing', 'Grant applications, accreditation materials, and school marketing or recruitment materials', MEDIA_USE_OPTIONS, { required: true }),
    radio('use_video_internal', 'Video recordings used for internal classroom documentation and professional development', MEDIA_USE_OPTIONS, { required: true }),
    radio('use_video_public', 'Video recordings shared publicly or semi-publicly (school website, social media, community presentations)', MEDIA_USE_OPTIONS, { required: true }),

    section('Section B — Special Instructions or Restrictions'),
    area('special_instructions', 'Notes / restrictions', { rows: 4, help: 'If you have specific concerns, restrictions, or notes regarding the use of your child\'s image, describe them here.' }),

    section('Section C — Student Information'),
    studentPicker(),
    select('classroom_level', 'Classroom / Level', CLASSROOM_LEVELS, { required: true }),
    txt('school_year', 'School year', { placeholder: 'e.g. 2026–2027', required: true }),

    section('Signatures'),
    ...sign('parent_1', 'Parent / Guardian 1', { required: true }),
    ...sign('parent_2', 'Parent / Guardian 2 (if applicable)'),
  ],
};

// ── Form 9.3 — Emergency Contact & Medical Information ─────────────
const F93 = {
  slug: 'nlma-emergency-medical',
  display_name: 'Form 9.3 — Emergency Contact & Medical Information',
  description: 'Required annually. Must also be updated immediately whenever relevant information changes.',
  category: 'medical',
  per_student: true,
  field_schema: [
    header('Emergency Contact & Medical Information Form'),
    para('The information you provide here is kept strictly confidential and is used solely to ensure your child\'s safety while in our care. Please review and resubmit this form at the start of each school year and whenever relevant information changes.', 'note'),

    section('Section A — Student Information'),
    studentPicker(),
    txt('preferred_name', 'Preferred name / nickname'),
    date('dob', 'Date of birth', { required: true }),
    txt('gender', 'Gender (optional)'),
    txt('home_address_street', 'Home address — street'),
    txt('home_address_city', 'Home address — city', { width: 'half' }),
    txt('home_address_state', 'Home address — state', { width: 'half' }),
    txt('home_address_zip', 'Home address — ZIP', { width: 'half' }),
    phone('home_phone', 'Home phone', { width: 'half' }),
    select('classroom_level', 'Classroom / Level', CLASSROOM_LEVELS, { required: true }),

    section('Section B — Parent / Guardian 1'),
    txt('pg1_name', 'Full name', { required: true }),
    txt('pg1_relationship', 'Relationship to child', { required: true }),
    phone('pg1_cell', 'Cell phone', { required: true, width: 'half' }),
    phone('pg1_work', 'Work phone', { width: 'half' }),
    email('pg1_email', 'Email address', { required: true }),

    section('Section C — Parent / Guardian 2 (if applicable)'),
    txt('pg2_name', 'Full name'),
    txt('pg2_relationship', 'Relationship to child'),
    phone('pg2_cell', 'Cell phone', { width: 'half' }),
    phone('pg2_work', 'Work phone', { width: 'half' }),
    email('pg2_email', 'Email address'),

    section('Section D — Additional Emergency Contacts'),
    para('Please list two individuals (beyond the parents/guardians above) who are authorized to be contacted in an emergency and may pick up your child.'),
    txt('ec1_name', 'Emergency Contact 1 — Full name', { required: true }),
    txt('ec1_relationship', 'Emergency Contact 1 — Relationship'),
    phone('ec1_phone', 'Emergency Contact 1 — Phone', { required: true }),
    txt('ec2_name', 'Emergency Contact 2 — Full name', { required: true }),
    txt('ec2_relationship', 'Emergency Contact 2 — Relationship'),
    phone('ec2_phone', 'Emergency Contact 2 — Phone', { required: true }),

    section('Section E — Authorized Pick-Up List'),
    para('The parents/guardians listed above are automatically authorized for pick-up. List any additional individuals authorized to pick up your child below:'),
    txt('pickup1_name', 'Authorized pick-up 1 — Full name'),
    txt('pickup1_relationship', 'Authorized pick-up 1 — Relationship'),
    phone('pickup1_phone', 'Authorized pick-up 1 — Phone'),
    txt('pickup2_name', 'Authorized pick-up 2 — Full name'),
    txt('pickup2_relationship', 'Authorized pick-up 2 — Relationship'),
    phone('pickup2_phone', 'Authorized pick-up 2 — Phone'),
    txt('pickup3_name', 'Authorized pick-up 3 — Full name'),
    txt('pickup3_relationship', 'Authorized pick-up 3 — Relationship'),
    phone('pickup3_phone', 'Authorized pick-up 3 — Phone'),

    section('Section F — Medical Information'),
    txt('physician_name', 'Physician / pediatrician name', { width: 'half' }),
    txt('clinic_name', 'Clinic / practice name', { width: 'half' }),
    phone('physician_phone', 'Physician phone', { width: 'half' }),
    txt('insurance_provider', 'Health insurance provider', { width: 'half' }),
    txt('insurance_policy_number', 'Policy / member number', { width: 'half' }),
    area('allergies', 'Known allergies', { rows: 3, help: 'List all known allergies and indicate severity. If none, write "None".', required: true }),
    area('current_medications', 'Current medications', { rows: 3, help: 'List all medications taken regularly. If none, write "None".', required: true }),
    area('medical_conditions', 'Medical conditions or special health needs', { rows: 3, help: 'Describe any conditions, diagnoses, or health considerations our staff should be aware of. If none, write "None".', required: true }),
    multi('immunization_status', 'Immunization status', ['Up to Date', 'Not Up to Date', 'Medical Exemption on File', 'Religious Exemption on File'], { required: true }),

    section('Section G — In Case of Emergency'),
    check('agree_911_protocol', 'I understand that in a medical emergency, NLMA staff will call 911 first, then immediately notify the parent/guardian (NLMA standard emergency protocol).', { required: true }),
    txt('hospital_preference', 'Hospital preference (if any)'),
    area('additional_emergency_notes', 'Additional emergency notes', { rows: 3 }),

    section('Signature'),
    ...sign('parent', 'Parent / Guardian', { required: true }),
  ],
};

// ── Form 9.4 — Allergy Action Plan ─────────────────────────────────
const SYMPTOM_OPTIONS = {
  skin: ['Hives or raised welts', 'Redness or flushing', 'Swelling (face, lips, tongue, throat)', 'Itching or rash'],
  respiratory: ['Coughing', 'Wheezing', 'Shortness of breath', 'Throat tightness or hoarseness', 'Runny or congested nose'],
  gi: ['Nausea', 'Vomiting', 'Abdominal cramping or pain', 'Diarrhea'],
  cardio: ['Pale or bluish skin coloring', 'Faintness or dizziness', 'Rapid or weak heartbeat', 'Drop in blood pressure'],
  neuro: ['Anxiety or sense of doom', 'Confusion or disorientation', 'Loss of consciousness'],
};
const F94 = {
  slug: 'nlma-allergy-action-plan',
  display_name: 'Form 9.4 — Allergy Action Plan',
  description: 'Required for students with documented allergies. Physician signature required.',
  category: 'medical',
  per_student: true,
  field_schema: [
    header('Allergy Action Plan Template'),
    para('This Allergy Action Plan is completed as a collaborative partnership between the family, the NLMA Health Coordinator, and the child\'s licensed physician. A physician signature is required before the plan may be activated.', 'note'),

    section('Section A — Student Information'),
    studentPicker(),
    date('dob', 'Date of birth', { required: true }),
    select('classroom_level', 'Classroom / Level', CLASSROOM_LEVELS, { required: true }),
    txt('parent_emergency_contact', 'Parent / Guardian emergency contact (name + phone)', { required: true }),

    section('Section B — Allergy Information'),
    area('known_allergens', 'Known allergen(s)', { rows: 2, required: true }),
    multi('type_of_allergy', 'Type of allergy', ['Food', 'Environmental (pollen, pets, mold)', 'Insect Sting/Bite', 'Medication', 'Other'], { required: true }),
    txt('type_of_allergy_other', 'If "Other", specify'),
    radio('overall_severity', 'Overall severity', ['Mild', 'Moderate', 'Severe', 'Risk of Anaphylaxis'], { required: true }),

    section('Section C — Symptoms to Watch For'),
    multi('symptoms_skin', 'Skin symptoms', SYMPTOM_OPTIONS.skin),
    multi('symptoms_respiratory', 'Respiratory symptoms', SYMPTOM_OPTIONS.respiratory),
    multi('symptoms_gi', 'Gastrointestinal symptoms', SYMPTOM_OPTIONS.gi),
    multi('symptoms_cardio', 'Cardiovascular symptoms', SYMPTOM_OPTIONS.cardio),
    multi('symptoms_neuro', 'Neurological / other symptoms', SYMPTOM_OPTIONS.neuro),

    section('Section D — Emergency Treatment Protocol'),
    para('Step 1 — Remove from exposure / Mild symptoms: Remove child from the source of allergen exposure immediately. If symptoms are mild, administer antihistamine as directed:'),
    txt('step1_antihistamine_name', 'Step 1 — Antihistamine medication name'),
    txt('step1_dose', 'Step 1 — Dose'),
    txt('step1_route', 'Step 1 — Route (oral/topical/etc.)'),
    para('Step 2 — Moderate to severe symptoms / worsening reaction: If symptoms are moderate, severe, or rapidly worsening, administer epinephrine auto-injector (EpiPen® or equivalent) if prescribed:'),
    txt('step2_epi_location', 'Step 2 — Location of epinephrine in school'),
    txt('step2_epi_dose', 'Step 2 — Epinephrine dose'),
    para('Step 3 — Call 911 immediately. After administering epinephrine (or if epinephrine is not available and symptoms are severe), call 911 immediately. Do not wait to see if symptoms improve.'),
    para('Step 4 — Notify parent / guardian. Attempt to reach the parent or guardian at the numbers on Form 9.3 as soon as possible after calling 911.'),
    para('Step 5 — Do not leave child unattended. A staff member must remain with the child until emergency medical services arrive or the child is transferred to parent/guardian or medical personnel.'),

    section('Section E — Medications Kept at School'),
    txt('med1_name', 'Medication 1 — Name'),
    txt('med1_form', 'Medication 1 — Form (tablet/liquid/auto-injector)'),
    txt('med1_dose', 'Medication 1 — Dose'),
    txt('med1_storage', 'Medication 1 — Storage location at school'),
    txt('med2_name', 'Medication 2 — Name'),
    txt('med2_form', 'Medication 2 — Form'),
    txt('med2_dose', 'Medication 2 — Dose'),
    txt('med2_storage', 'Medication 2 — Storage location'),

    section('Section F — Dietary / Environmental Restrictions at School'),
    area('dietary_environmental_restrictions', 'Describe specific foods, environmental exposures, activities, or materials that must be avoided', { rows: 4, required: true }),

    section('Signatures'),
    ...sign('parent', 'Parent / Guardian', { required: true }),
    ...sign('physician', 'Physician', { required: true }),
    txt('physician_name', 'Physician — printed full name', { required: true }),
    txt('physician_license', 'Physician — license number', { required: true }),
    ...sign('health_coordinator', 'School Health Coordinator'),
  ],
};

// ── Form 9.5 — Medication Authorization ────────────────────────────
const F95 = {
  slug: 'nlma-medication-authorization',
  display_name: 'Form 9.5 — Medication Authorization',
  description: 'Required when staff will administer medication to a student. All medication must be in original, labeled container.',
  category: 'medical',
  per_student: true,
  field_schema: [
    header('Medication Authorization Form'),
    para('NLMA staff may only administer medication with valid written authorization from a parent/guardian. For prescription medications, authorization from the prescribing licensed healthcare provider is also required. All medication must be provided in its original, labeled container.', 'note'),

    section('Section A — Student Information'),
    studentPicker(),
    date('dob', 'Date of birth', { required: true }),
    select('classroom_level', 'Classroom / Level', CLASSROOM_LEVELS, { required: true }),
    txt('weight', 'Student weight (if relevant for dosing)', { width: 'half' }),
    radio('weight_unit', 'Weight unit', ['lbs', 'kg'], { width: 'half' }),

    section('Section B — Medication Details'),
    para('Complete one set for each medication. Leave additional rows blank if not applicable.'),
    txt('med1_name', 'Medication 1 — Name', { required: true }),
    txt('med1_purpose', 'Medication 1 — Purpose / condition being treated'),
    txt('med1_dose', 'Medication 1 — Dose'),
    select('med1_route', 'Medication 1 — Route', ['Oral', 'Topical', 'Inhaled', 'Injected', 'Other']),
    txt('med1_frequency', 'Medication 1 — Frequency'),
    date('med1_start_date', 'Medication 1 — Start date'),
    date('med1_end_date', 'Medication 1 — End date'),
    txt('med2_name', 'Medication 2 — Name'),
    txt('med2_purpose', 'Medication 2 — Purpose'),
    txt('med2_dose', 'Medication 2 — Dose'),
    select('med2_route', 'Medication 2 — Route', ['Oral', 'Topical', 'Inhaled', 'Injected', 'Other']),
    txt('med2_frequency', 'Medication 2 — Frequency'),
    date('med2_start_date', 'Medication 2 — Start date'),
    date('med2_end_date', 'Medication 2 — End date'),

    section('Section C — Special Instructions'),
    area('special_instructions', 'Storage requirements, timing notes, potential side effects to monitor, or other instructions for NLMA staff', { rows: 4 }),

    section('Section D — Authorization'),
    para('By signing below, I authorize NLMA staff to administer the medication(s) listed in Section B to my child as directed. I understand that staff will maintain a log of all doses administered and will contact me if my child experiences any adverse reaction. I am responsible for providing an adequate supply of medication and picking up any remaining medication by the end date.'),
    ...sign('parent', 'Parent / Guardian', { required: true }),

    section('For Prescription Medications — Physician Authorization (required)'),
    txt('physician_name', 'Physician name', { required: false }),
    txt('physician_license', 'Physician license number'),
    phone('physician_phone', 'Physician phone'),
    ...sign('physician', 'Physician'),
  ],
};

// ── Form 9.6 — Field Trip & Going-Out Permission ───────────────────
const F96 = {
  slug: 'nlma-field-trip-going-out',
  display_name: 'Form 9.6 — Field Trip & Going-Out Permission',
  description: 'Annual blanket permission + per-trip specifics. Required for school-organized trips and Going-Out excursions.',
  category: 'permission',
  per_student: true,
  field_schema: [
    header('Field Trip & Going-Out Permission Form'),
    para('NLMA organizes traditional school-wide and class field trips throughout the year, plus Montessori "Going-Out" excursions for older students. Both types require family permission.'),

    section('Section A — Student Information & Annual Blanket Permission'),
    studentPicker(),
    select('classroom_level', 'Classroom / Level', CLASSROOM_LEVELS, { required: true }),
    check('annual_blanket_permission', 'I give permission for my child to participate in all school-organized field trips and Going-Out excursions during the current school year, subject to individual notices provided for each trip. I understand I may withdraw permission for any specific trip by contacting the office in writing before the trip date.'),

    section('Section B — Trip-Specific Permission'),
    para('Complete this section for each individual trip (or use the annual blanket permission above and skip).'),
    txt('trip_name', 'Trip name / destination'),
    date('trip_date_start', 'Trip date (start)', { width: 'half' }),
    date('trip_date_end', 'Trip date (end if multi-day)', { width: 'half' }),
    txt('departure_time', 'Departure time', { width: 'half' }),
    txt('return_time', 'Expected return time', { width: 'half' }),
    multi('transportation_mode', 'Mode of transportation', ['School Bus', 'Charter Vehicle', 'Walking', 'Parent Driver Volunteer', 'Public Transit', 'Other']),
    txt('transportation_other', 'If "Other", specify'),
    txt('supervising_staff', 'Supervising staff / guides'),
    txt('cost', 'Cost (if applicable)'),
    area('purpose', 'Purpose / learning objective', { rows: 3 }),
    radio('permission_decision', 'My permission decision', [
      { value: 'yes', label: 'Yes — My child may participate in this trip as described.' },
      { value: 'no',  label: 'No — My child will not participate. I understand alternate in-school arrangements will be made.' },
    ]),
    check('chaperone_available', 'I am available and willing to serve as a chaperone for this trip. (Requires NLMA volunteer background check on file.)'),

    section('Section C — Medical & Emergency Reminders'),
    para('Please ensure your child\'s Emergency Contact form (Form 9.3) is current before this trip.'),
    area('special_medical_needs', 'Special medical needs for this trip', { rows: 3, help: 'Required medication, allergy kit, epi-pen, etc.' }),

    section('Section D — Photo / Media Release Reminder'),
    para('Your media release preferences on file (Form 9.2) will apply to all photos/videos taken during this trip.'),

    section('Signature'),
    ...sign('parent', 'Parent / Guardian', { required: true }),
  ],
};

// ── Form 9.7 — Transportation Permission ───────────────────────────
const F97 = {
  slug: 'nlma-transportation-permission',
  display_name: 'Form 9.7 — Transportation Permission',
  description: 'Establishes your child\'s standard daily transportation arrangement for the school year.',
  category: 'permission',
  per_student: true,
  field_schema: [
    header('Transportation Permission Form'),
    para('This form establishes your child\'s standard daily transportation arrangement. No changes will be honored without written notice to the main office by 1:00 PM on the day of the change.', 'note'),

    section('Section A — Student Information'),
    studentPicker(),
    date('dob', 'Date of birth'),
    select('classroom_level', 'Classroom / Level', CLASSROOM_LEVELS, { required: true }),
    txt('home_address', 'Home address'),

    section('Section B — Standard Daily Transportation Plan'),
    multi('transportation_plan', 'Check all options that apply', ['Parent/Guardian Drop-Off and Pick-Up', 'School Bus Transportation', 'Carpool', 'Walking or Biking Independently', 'After-School Program Transportation'], { required: true }),

    section('School Bus — if applicable'),
    radio('bus_routes', 'Bus route', [
      { value: 'morning',  label: 'Morning route (to school) only' },
      { value: 'afternoon', label: 'Afternoon route (from school) only' },
      { value: 'both',     label: 'Both morning and afternoon' },
    ]),
    txt('bus_route_number', 'Bus route number / name', { width: 'half' }),
    txt('bus_stop_location', 'Bus stop location', { width: 'half' }),

    section('After-School Program — if applicable'),
    txt('aftercare_program_name', 'Program name', { width: 'half' }),
    txt('aftercare_pickup_arrangement', 'Pickup arrangement', { width: 'half' }),

    section('Section C — Authorized Carpool Drivers'),
    para('List all adults authorized to drive your child to or from school as part of a carpool arrangement. For privacy, only provide the last 4 digits of the driver\'s license number.'),
    txt('carpool1_name', 'Driver 1 — Full name'),
    txt('carpool1_relationship', 'Driver 1 — Relationship'),
    phone('carpool1_phone', 'Driver 1 — Phone'),
    txt('carpool1_license_state', 'Driver 1 — License state'),
    txt('carpool1_license_last4', 'Driver 1 — License # (last 4 digits)'),
    txt('carpool2_name', 'Driver 2 — Full name'),
    txt('carpool2_relationship', 'Driver 2 — Relationship'),
    phone('carpool2_phone', 'Driver 2 — Phone'),
    txt('carpool2_license_state', 'Driver 2 — License state'),
    txt('carpool2_license_last4', 'Driver 2 — License # (last 4 digits)'),
    txt('carpool3_name', 'Driver 3 — Full name'),
    txt('carpool3_relationship', 'Driver 3 — Relationship'),
    phone('carpool3_phone', 'Driver 3 — Phone'),
    txt('carpool3_license_state', 'Driver 3 — License state'),
    txt('carpool3_license_last4', 'Driver 3 — License # (last 4 digits)'),

    section('Section D — Bus Transportation Agreement'),
    check('agree_bus_conduct', 'I understand my child is expected to follow the Code of Conduct and all bus rules. Failure to comply may result in loss of bus privileges.'),
    radio('classmate_ride_permission', 'Permission for my child to ride the bus home with a classmate (occasional basis)', [
      { value: 'yes', label: 'Yes — written notice required each time' },
      { value: 'no',  label: 'No' },
    ]),

    section('Section E — Walking / Independent Travel Permission'),
    check('permission_independent_walking', 'I give permission for my child to walk or bike to and/or from school independently on a regular basis.'),
    area('approximate_route', 'Approximate route / notes', { rows: 3 }),
    check('attest_safe_practices', 'I attest that my child is aware of safe pedestrian/cyclist practices, knows the approved route, and has my full permission to travel independently.'),

    section('Section F — Changes to Transportation'),
    para('Same-day transportation changes must be in writing to the Main Office by 1:00 PM. Verbal instructions to classroom guides or other staff cannot be guaranteed and will not be honored.'),

    section('Signature'),
    ...sign('parent', 'Parent / Guardian', { required: true }),
  ],
};

// ── Form 9.8 — Technology & Device Agreement ───────────────────────
const F98 = {
  slug: 'nlma-technology-device-agreement',
  display_name: 'Form 9.8 — Technology & Device Agreement',
  description: 'All students using technology at school sign this agreement with a parent/guardian.',
  category: 'legal',
  per_student: true,
  field_schema: [
    header('Technology & Device Agreement'),
    para('NLMA integrates technology thoughtfully into the Montessori curriculum. This agreement applies to all students who use technology at school. Both the student (where age-appropriate) and a parent/guardian should review, initial, and sign together.'),

    section('Section A — Student Information'),
    studentPicker(),
    select('classroom_level', 'Classroom / Level', CLASSROOM_LEVELS, { required: true }),
    txt('school_year', 'School year', { placeholder: 'e.g. 2026–2027', required: true }),
    multi('devices_used', 'Device(s) to be used at school', ['School-Owned Device(s) Only', 'Personal Device (as permitted)', 'Both']),

    section('Section B — Student Responsibilities'),
    para('Please check each responsibility statement to confirm understanding and agreement.'),
    check('resp_1', '1. I will use technology only for educational purposes during school hours, as directed by my guide or classroom staff.', { required: true }),
    check('resp_2', '2. I will handle all devices carefully, keeping them away from food and liquids, and will report any damage or malfunction to a staff member immediately.', { required: true }),
    check('resp_3', '3. I will not share my login credentials, passwords, or account information with other students.', { required: true }),
    check('resp_4', '4. I will not access inappropriate, harmful, violent, or non-educational content on any device.', { required: true }),
    check('resp_5', '5. I will not download, install, or use any software/application on a school device without explicit permission.', { required: true }),
    check('resp_6', '6. I will not use any device for personal communication, texting, gaming, or social media during school hours unless explicitly authorized for an educational purpose.', { required: true }),
    check('resp_7', '7. I will respect the privacy and dignity of classmates and staff. I will not take photos, videos, or audio recordings of anyone at school without explicit permission.', { required: true }),
    check('resp_8', '8. I will honor time limits and transitions away from screens as directed by my guide.', { required: true }),
    check('resp_9', '9. If I bring a personal device, I will ensure it is fully charged and ready, and I accept responsibility for its security and care.', { required: true }),
    check('resp_10', '10. I understand my use of school technology may be monitored by NLMA staff and administrators.', { required: true }),

    section('Section C — Parent / Guardian Agreement'),
    para('As a parent/guardian, I agree to actively support responsible and purposeful technology use at home. I understand the following regarding consequences for misuse:'),
    para('• Misuse will result in a loss of technology privileges for a period determined by administration.\n• Repeated or serious misuse will result in a required parent conference before privileges are restored.\n• Damage from negligent or deliberate misuse of a school-owned device may result in repair/replacement costs billed to the family.\n• Serious violations — cyberbullying, accessing prohibited content, unauthorized recording — will be addressed under the Code of Conduct.'),
    check('pg_agree_support', 'I agree to support these expectations at home and will notify NLMA promptly if my child\'s personal device is lost, stolen, or compromised.', { required: true }),

    section('Section D — Consequences for Misuse (Summary)'),
    para('First Incident: Verbal correction and documented note home; temporary restriction of device use.\nSecond Incident: Parent notification and conference with guide; loss of privileges for up to one week.\nThird Incident or Serious Violation: Formal parent-administration conference; extended or permanent loss of privileges; possible additional disciplinary action.\nDevice Damage: Family may be responsible for repair or replacement costs.'),

    section('Signatures'),
    ...sign('student', 'Student (if age-appropriate)'),
    ...sign('parent', 'Parent / Guardian', { required: true }),
    ...sign('staff_witness', 'Guide / Staff Witness'),
  ],
};

// ── Form 9.9 — Custody & Court Order Documentation ─────────────────
const F99 = {
  slug: 'nlma-custody-court-order',
  display_name: 'Form 9.9 — Custody & Court Order Documentation',
  description: 'Only required when a legal custody arrangement or court order affects school operations.',
  category: 'legal',
  per_student: true,
  field_schema: [
    header('Custody & Court Order Documentation Form'),
    para('NLMA is committed to supporting all family structures with respect, sensitivity, and dignity. When a custody arrangement or court order affects school procedures — pick-up, communication, enrollment decisions, or emergency protocols — NLMA is required to have documentation on file.', 'note'),
    para('All information provided on this form is strictly confidential and will be shared only with NLMA staff on a need-to-know basis.', 'note'),

    section('Section A — Student Information'),
    studentPicker(),
    date('dob', 'Date of birth', { required: true }),
    select('classroom_level', 'Classroom / Level', CLASSROOM_LEVELS, { required: true }),

    section('Section B — Custody Arrangement'),
    radio('legal_custody_type', 'Type of legal custody', [
      { value: 'sole_legal',  label: 'Sole Legal Custody — one parent/guardian holds legal decision-making authority' },
      { value: 'joint_legal', label: 'Joint Legal Custody — both parents/guardians share legal decision-making' },
      { value: 'other',       label: 'Other — specify below' },
    ], { required: true }),
    txt('legal_custody_other', 'If "Other", specify'),

    section('Primary Residential Parent / Guardian'),
    txt('primary_name', 'Full name', { required: true }),
    txt('primary_relationship', 'Relationship to child'),
    phone('primary_phone', 'Phone'),
    email('primary_email', 'Email'),

    section('Secondary Residential Parent / Guardian (if applicable)'),
    txt('secondary_name', 'Full name'),
    txt('secondary_relationship', 'Relationship to child'),
    phone('secondary_phone', 'Phone'),
    email('secondary_email', 'Email'),
    area('custody_schedule_summary', 'Custody / visitation schedule summary', { rows: 3, help: 'Describe in general terms relevant to school operations — e.g., "alternating weeks," "Child is with Parent A Monday–Wednesday; Parent B Thursday–Sunday."' }),

    section('Section C — Court Order Details'),
    check('court_order_in_effect', 'A court order is currently in effect that affects school procedures for this student.'),
    date('court_order_date', 'Court order date'),
    txt('issuing_court', 'Issuing court / jurisdiction'),
    area('summary_of_restrictions', 'Summary of restrictions or requirements relevant to school', { rows: 4, help: 'e.g., "Parent B is not authorized to pick up the student," "Both parents must be notified of school events independently."' }),
    check('certified_copy_attached', 'A certified copy of the relevant court order pages is attached to this submission.'),

    section('Section D — Communication Preferences'),
    radio('communication_preference', 'Communication preference', [
      { value: 'both_independently', label: 'Both parents/guardians should receive all school communications independently and simultaneously.' },
      { value: 'primary_only',       label: 'Only the primary custodial parent/guardian should receive regular communications.' },
      { value: 'other',              label: 'Other — specify below' },
    ], { required: true }),
    txt('communication_other', 'If "Other", specify'),

    section('Section E — Emergency Protocol'),
    para('In an emergency, NLMA will attempt to contact the following individuals in the order listed. Please ensure these contacts are consistent with any court order on file.'),
    txt('emergency_1_name', 'Priority 1 — Name'),
    txt('emergency_1_relationship', 'Priority 1 — Relationship'),
    phone('emergency_1_phone', 'Priority 1 — Phone'),
    txt('emergency_2_name', 'Priority 2 — Name'),
    txt('emergency_2_relationship', 'Priority 2 — Relationship'),
    phone('emergency_2_phone', 'Priority 2 — Phone'),
    txt('emergency_3_name', 'Priority 3 — Name'),
    txt('emergency_3_relationship', 'Priority 3 — Relationship'),
    phone('emergency_3_phone', 'Priority 3 — Phone'),
    area('emergency_restrictions', 'Emergency restrictions', { rows: 3, help: 'e.g., "Do not release child to [name] under any circumstances."' }),

    section('Signatures'),
    ...sign('completing_parent', 'Parent / Guardian completing this form', { required: true }),
    txt('completing_parent_printed', 'Printed name of completing parent / guardian', { required: true }),
    ...sign('second_parent', 'Second Parent / Guardian (optional — if both parties agree)'),
  ],
};

const FORMS = [F91, F92, F93, F94, F95, F96, F97, F98, F99];

// ── seeder ──────────────────────────────────────────────────────────
async function main() {
  console.log(`Mode: ${REFRESH ? 'REFRESH (force-overwrite curated)' : 'INSERT-ONLY (preserve curated)'}`);
  console.log(`School: NLMA (${NLMA_SCHOOL_ID})\n`);

  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  let inserted = 0, updated = 0, skipped = 0;
  for (const f of FORMS) {
    const existing = await pool.query(
      `SELECT id, needs_review FROM portal_form_definitions WHERE school_id = $1 AND slug = $2`,
      [NLMA_SCHOOL_ID, f.slug],
    );
    if (existing.rows.length > 0 && !REFRESH && existing.rows[0].needs_review === false) {
      console.log(`  · ${f.slug.padEnd(45)} skipped (curated; pass --refresh to override)`);
      skipped++;
      continue;
    }
    const isUpdate = existing.rows.length > 0;
    await pool.query(
      `INSERT INTO portal_form_definitions
         (school_id, slug, display_name, description, category, per_student,
          is_active, needs_review, audience, field_schema, notify_emails)
       VALUES ($1, $2, $3, $4, $5, $6, false, true, 'parents', $7::jsonb, $8::text[])
       ON CONFLICT (school_id, slug) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         description = EXCLUDED.description,
         category = EXCLUDED.category,
         per_student = EXCLUDED.per_student,
         field_schema = EXCLUDED.field_schema,
         updated_at = now()`,
      [NLMA_SCHOOL_ID, f.slug, f.display_name, f.description, f.category, f.per_student,
       JSON.stringify(f.field_schema), []],
    );
    console.log(`  ${isUpdate ? '↻' : '+'} ${f.slug.padEnd(45)} — ${f.field_schema.length} blocks, audience=parents, status=draft`);
    if (isUpdate) updated++; else inserted++;
  }

  console.log(`\nDone. ${inserted} created, ${updated} updated, ${skipped} skipped.`);
  console.log(`\nAll forms are seeded as DRAFTS (is_active=false). NLMA admin can review + edit in the embedded Forms tab,`);
  console.log(`then flip the Published toggle when ready to expose them to parents.`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
