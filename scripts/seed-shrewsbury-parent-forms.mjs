// Seed Shrewsbury Montessori parent-portal forms.
//
// Source: PDFs in ../Shrewsbury Forms/ (sibling folder outside the repo).
// Field schemas mirror each source form verbatim — every label, section
// header, acknowledgement, and option pulled directly from the PDFs
// per Clint's 2026-06-19 directive that language not be modified
// during import.
//
// Three additions across every form (approved by Clint 2026-06-19):
//   1. student_picker at the top — replaces the manual "Child's Name"
//      and "Date of Birth" fields. Picker auto-attaches the kid + DOB
//      to the submission record.
//   2. file_upload on the 4 provider-signed forms (Asthma, FARE, IHCP,
//      Medication Order) — accepts the doctor-signed scan since
//      physicians don't e-sign.
//   3. Typed signature (text input where the parent types their full
//      name) + date — NOT a canvas / drawing. Default per the typed-
//      signatures memory.
//
// Forms seeded (8):
//   1. shrewsbury-asthma-action-plan       (AAFA — provider-signed)
//   2. shrewsbury-eec-transportation       (MA EEC — release list + plan)
//   3. shrewsbury-eec-developmental        (MA EEC — yearly, due Aug 15)
//   4. shrewsbury-fare-anaphylaxis-plan    (FARE — provider-signed)
//   5. shrewsbury-ihcp                     (chronic condition care plan)
//   6. shrewsbury-medication-order         (Part A provider, Part B parent)
//   7. shrewsbury-otc-standing-orders      (14 OTC meds + 3-way consent)
//   8. shrewsbury-first-aid-consent        (emergency care + transport)
//
// All seeded as DRAFT (is_active=false) per Clint's standing rule that
// new forms get reviewed in the portal before going live to parents.
//
// Notify default: office@shrewsburymontessori.org (printed on the EEC
// Transportation PDF). Operators can edit per-form via the form editor.
//
// Usage:
//   node scripts/seed-shrewsbury-parent-forms.mjs               # default
//   node scripts/seed-shrewsbury-parent-forms.mjs --refresh     # overwrite curated forms

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

const envText = readFileSync(join(projectRoot, '.env.local'), 'utf8');
for (const line of envText.split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('=');
  if (eq === -1) continue;
  const k = t.slice(0, eq).trim();
  if (!process.env[k]) process.env[k] = t.slice(eq + 1).trim();
}

const args = { refresh: process.argv.includes('--refresh') };

const SHREWSBURY_SCHOOL_ID = 'bf5e15d7-c0df-4ac6-9b6f-ededee90b02a';
const SHREWSBURY_NOTIFY_EMAIL = 'office@shrewsburymontessori.org';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── Block helpers (match MCH/NLMA seeders for consistency) ──────────
const blockHeader = (text) => ({ type: 'header', text });
const blockSection = (label, description) =>
  description ? { type: 'section', label, description } : { type: 'section', label };
const blockParagraph = (text, emphasis) =>
  emphasis ? { type: 'paragraph', text, emphasis } : { type: 'paragraph', text };
const txt = (key, label, opts = {}) => ({ type: 'text', key, label, ...opts });
const area = (key, label, opts = {}) => ({ type: 'textarea', key, label, rows: 3, ...opts });
const tel = (key, label, opts = {}) => ({ type: 'tel', key, label, ...opts });
const email = (key, label, opts = {}) => ({ type: 'email', key, label, ...opts });
const dateF = (key, label, opts = {}) => ({ type: 'date', key, label, ...opts });
const numF = (key, label, opts = {}) => ({ type: 'number', key, label, ...opts });
const fileF = (key, label, opts = {}) =>
  ({ type: 'file_upload', key, label, max_size_mb: 10, ...opts });
const radioF = (key, label, options, opts = {}) => ({
  type: 'radio', key, label,
  options: options.map((v) => typeof v === 'string' ? { value: keyify(v), label: v } : v),
  ...opts,
});
const checkF = (key, label, opts = {}) => ({ type: 'checkbox', key, label, ...opts });
const multiF = (key, label, options, opts = {}) => ({
  type: 'multi_checkbox', key, label,
  options: options.map((v) => typeof v === 'string' ? { value: keyify(v), label: v } : v),
  ...opts,
});
const studentPicker = (opts = {}) => ({
  type: 'student_picker',
  key: 'child',
  label: opts.label ?? "Child's name",
  required: true,
  help: opts.help ?? "Pick your child — we'll auto-attach the name and date of birth to this submission.",
  ...opts,
});
// Typed signature block — text field + date. Replaces the wet/canvas
// signature on every form per the typed-signatures-feedback memory.
const typedSignature = (keyPrefix, signerLabel, opts = {}) => [
  txt(`${keyPrefix}_signature`,
    `${signerLabel} — typed full name (acts as signature)`,
    { required: opts.required ?? true,
      help: 'By typing your full legal name below, you confirm this is your signature and you agree to the statements above.' }),
  dateF(`${keyPrefix}_signature_date`, 'Date', { required: opts.required ?? true }),
];

const keyify = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);

// ────────────────────────────────────────────────────────────────────
// 1. ASTHMA ACTION PLAN  (AAFA standardized — provider-signed)
// ────────────────────────────────────────────────────────────────────
function asthmaActionPlan() {
  return {
    slug: 'shrewsbury-asthma-action-plan',
    display_name: 'Asthma Action Plan',
    description:
      "AAFA-standardized Asthma Action Plan. Requires the child's doctor to fill in " +
      "medications + peak-flow ranges for each zone (Green / Yellow / Red) and sign. " +
      "Upload the signed copy at the bottom; you can also type out the details below " +
      "so we have a digital record.",
    category: 'medical',
    per_student: true,
    confirmation_message:
      "Thanks! Your child's Asthma Action Plan is on file with the office. " +
      "We'll review with the school nurse and follow up if anything needs clarification.",
    field_schema: [
      blockHeader('ASTHMA ACTION PLAN'),
      blockParagraph(
        'The colors of a traffic light will help you use your asthma medicines. ' +
        'GREEN means Go Zone! Use preventive medicine. ' +
        'YELLOW means Caution Zone! Add quick-relief medicine. ' +
        'RED means Danger Zone! Get help from a doctor.',
        'note',
      ),

      studentPicker(),
      dateF('plan_date', 'Date', { required: true }),

      blockSection('Doctor & Contacts'),
      txt('doctor_name', 'Doctor', { required: true }),
      txt('medical_record_number', 'Medical Record #'),
      tel('doctor_phone_day', "Doctor's Phone #: Day", { required: true }),
      tel('doctor_phone_night_weekend', 'Night/Weekend'),
      txt('emergency_contact', 'Emergency Contact', { required: true }),

      blockSection('Personal Best Peak Flow'),
      numF('personal_best_peak_flow', 'Personal Best Peak Flow', { required: false }),

      blockSection('GO — Use these daily controller medicines',
        "You have all of these: Breathing is good · No cough or wheeze · Sleep through the night · Can work & play"),
      txt('green_med_1_name',     'Medicine #1'),
      txt('green_med_1_how_much', 'How Much'),
      txt('green_med_1_how_often','How Often / When'),
      txt('green_med_2_name',     'Medicine #2'),
      txt('green_med_2_how_much', 'How Much'),
      txt('green_med_2_how_often','How Often / When'),
      txt('green_med_3_name',     'Medicine #3'),
      txt('green_med_3_how_much', 'How Much'),
      txt('green_med_3_how_often','How Often / When'),
      txt('green_peak_flow_from', 'Peak flow from'),
      txt('green_peak_flow_to',   'Peak flow to'),
      blockParagraph('For asthma with exercise, take:'),
      txt('green_exercise_med_name',     'Exercise medicine'),
      txt('green_exercise_med_how_much', 'How much'),
      txt('green_exercise_med_how_often','How often / when'),

      blockSection('CAUTION — Continue with green zone medicine and add',
        "You have any of these: First signs of a cold · Exposure to known trigger · Cough · Mild wheeze · Tight chest · Coughing at night"),
      txt('yellow_med_1_name',     'Medicine #1'),
      txt('yellow_med_1_how_much', 'How Much'),
      txt('yellow_med_1_how_often','How Often / When'),
      txt('yellow_med_2_name',     'Medicine #2'),
      txt('yellow_med_2_how_much', 'How Much'),
      txt('yellow_med_2_how_often','How Often / When'),
      txt('yellow_med_3_name',     'Medicine #3'),
      txt('yellow_med_3_how_much', 'How Much'),
      txt('yellow_med_3_how_often','How Often / When'),
      txt('yellow_peak_flow_from', 'Peak flow from'),
      txt('yellow_peak_flow_to',   'Peak flow to'),
      blockParagraph('CALL YOUR ASTHMA CARE PROVIDER.', 'warning'),

      blockSection('DANGER — Take these medicines and call your doctor now',
        "Your asthma is getting worse fast: Medicine is not helping · Breathing is hard & fast · Nose opens wide · Trouble speaking · Ribs show (in children)"),
      txt('red_med_1_name',     'Medicine #1'),
      txt('red_med_1_how_much', 'How Much'),
      txt('red_med_1_how_often','How Often / When'),
      txt('red_med_2_name',     'Medicine #2'),
      txt('red_med_2_how_much', 'How Much'),
      txt('red_med_2_how_often','How Often / When'),
      txt('red_med_3_name',     'Medicine #3'),
      txt('red_med_3_how_much', 'How Much'),
      txt('red_med_3_how_often','How Often / When'),
      numF('red_peak_flow_reading_below', 'Peak flow reading below'),

      blockParagraph(
        "GET HELP FROM A DOCTOR NOW! Your doctor will want to see you right away. It's important! " +
        'If you cannot contact your doctor, go directly to the emergency room. DO NOT WAIT. ' +
        'Make an appointment with your asthma care provider within two days of an ER visit or hospitalization.',
        'warning',
      ),

      blockSection('Upload signed copy',
        "Your doctor signs the original Asthma Action Plan. Please upload a scan or photo of the signed page below."),
      fileF('signed_plan_upload', 'Upload signed Asthma Action Plan (PDF / image)',
        { required: false, accept: 'application/pdf,image/*' }),

      blockSection('Parent / Guardian Signature'),
      ...typedSignature('parent', 'Parent / Guardian'),
    ],
    notify_emails: [SHREWSBURY_NOTIFY_EMAIL],
  };
}

// ────────────────────────────────────────────────────────────────────
// 2. EEC TRANSPORTATION PLAN & RELEASE OF STUDENT  (MA EEC)
// ────────────────────────────────────────────────────────────────────
function eecTransportation() {
  return {
    slug: 'shrewsbury-eec-transportation',
    display_name: 'Transportation Plan & Release of Student (EEC)',
    description:
      'Massachusetts Department of Early Education and Care required form. Lists who is ' +
      'authorized to pick up your child and how the child gets to and from school. ' +
      'Resubmit any time the release list changes.',
    category: 'permission',
    per_student: true,
    confirmation_message:
      "Thanks! Your Transportation & Release form is on file with the office.",
    field_schema: [
      blockHeader('SMALL GROUP AND LARGE GROUP TRANSPORTATION PLAN AND AUTHORIZATION'),
      blockParagraph('The Commonwealth of Massachusetts Department of Early Education and Care'),
      blockParagraph('Release of Student'),

      studentPicker(),

      blockSection("Parent's Acknowledgement",
        'Please check each statement to acknowledge.'),
      checkF('ack_recognized_only',
        'Students will only be released to recognized parents, or recognized persons on this Release of Student List.',
        { required: true }),
      checkF('ack_photo_id',
        'The first time a non-parent on this Release List picks up a student, the non-parent will provide photo identification.',
        { required: true }),
      checkF('ack_send_note',
        'In order for the student to be released to another SMS parent, parents will send a note in with the student.',
        { required: true }),
      checkF('ack_callback',
        'If a parent calls with a request to release the child to someone NOT on the Release List below, the office will call the parent back to verify the message.',
        { required: true }),
      checkF('ack_changes',
        'Parents may make written changes to the Release List by coming into the office for a permanent change. Temporary changes can be made by sending in a note or emailing office@shrewsburymontessori.org.',
        { required: true }),

      blockSection('Release of Student List'),
      txt('release_1_name',         'Name (Release #1)',         { required: true }),
      txt('release_1_relationship', 'Relationship (Release #1)', { required: true }),
      tel('release_1_call',         'Call (Release #1)',         { required: true }),
      txt('release_2_name',         'Name (Release #2)'),
      txt('release_2_relationship', 'Relationship (Release #2)'),
      tel('release_2_call',         'Call (Release #2)'),
      txt('release_3_name',         'Name (Release #3)'),
      txt('release_3_relationship', 'Relationship (Release #3)'),
      tel('release_3_call',         'Call (Release #3)'),

      blockSection('Transportation Plan'),
      checkF('transport_parent_dropoff',  'Parent (Drop off)'),
      checkF('transport_parent_pickup',   'Parent (Pick up)'),
      checkF('transport_private_dropoff', 'Private Transportation (Drop off)'),
      checkF('transport_private_pickup',  'Private Transportation (Pick up)'),
      checkF('transport_carpool_dropoff', 'Carpool (Drop off)'),
      checkF('transport_carpool_pickup',  'Carpool (Pick up)'),

      blockSection('Parent / Guardian Signature'),
      ...typedSignature('parent', 'Parent / Guardian'),
    ],
    notify_emails: [SHREWSBURY_NOTIFY_EMAIL],
  };
}

// ────────────────────────────────────────────────────────────────────
// 3. EEC DEVELOPMENTAL HISTORY & BACKGROUND INFORMATION  (MA EEC)
// ────────────────────────────────────────────────────────────────────
function eecDevelopmental() {
  return {
    slug: 'shrewsbury-eec-developmental',
    display_name: 'Developmental History & Background Information (EEC)',
    description:
      'Massachusetts Department of Early Education and Care required form. Resubmit ' +
      'every year prior to the start of school — please return to SMS by August 15.',
    category: 'registration',
    per_student: true,
    confirmation_message:
      "Thanks! Your Developmental History form is on file with the office.",
    field_schema: [
      blockHeader('DEVELOPMENTAL HISTORY AND BACKGROUND INFORMATION'),
      blockParagraph(
        'THE COMMONWEALTH OF MASSACHUSETTS Department of Early Education and Care requires SMS parents ' +
        'to complete this form every year prior to the start of school. We thank you for your time. ' +
        'Please return this form to SMS by August 15. Thank you!',
        'note',
      ),

      studentPicker(),

      blockSection('DEVELOPMENTAL HISTORY'),
      txt('age_began_sitting',  'Age began sitting'),
      txt('age_began_crawling', 'crawling'),
      txt('age_began_walking',  'walking'),
      txt('age_began_talking',  'talking'),
      area('speech_difficulties', 'Any speech difficulties?'),
      area('special_words',       'Special words to describe needs'),
      txt('language_at_home',     'Language spoken at home'),

      blockSection('HEALTH'),
      area('birth_complications',          'Any known complications at birth?'),
      area('serious_illnesses',            'Serious illnesses and/or hospitalizations'),
      area('special_conditions_disabilities', 'Special physical conditions, disabilities'),

      blockSection('ALLERGIES (i.e. asthma, hay fever, insect bites, medicine, food reactions)'),
      area('allergies',           'Allergies', { rows: 3 }),
      area('regular_medications', 'Regular medications'),

      blockSection('EATING HABITS'),
      area('eating_special_characteristics', 'Special characteristics or difficulties'),
      area('favorite_foods',                 'Favorite foods'),
      txt('eats_with_spoon', 'Does your child eat with spoon?'),
      txt('eats_with_fork',  'Fork?'),
      txt('eats_with_hands', 'Hands?'),

      blockSection('TOILET HABITS'),
      area('toilet_training_attempted', 'Has toilet training been attempted?'),
      area('toilet_indicates_needs',    'How does your child indicate bathroom needs (include special words)'),
      area('toilet_reluctant',          'Is your child ever reluctant to use the bathroom?'),
      area('toilet_accidents',          'Does your child have accidents?'),

      blockSection('RESTING HABITS'),
      area('naps_when_how_long',   'Does your child become tired or nap during the day (include when and how long)?'),
      area('bedtime_wakeup',       'When does your child go to bed at night and get up in the morning?'),
      area('resting_special_needs','Describe any special characteristics or needs (stuffed animal, story, mood on waking etc)'),

      blockSection('SOCIAL RELATIONSHIPS'),
      area('describe_child',          'How would you describe your child?'),
      area('prior_daycare',           'Previous experience with other children/day care'),
      txt('reaction_to_strangers',    'Reaction to strangers'),
      txt('plays_alone',              'Able to play alone?'),
      area('favorite_toys_activities','Favorite toys and activities'),
      area('fears',                   'Fears (the dark, animals, etc.)'),
      area('how_to_comfort',          'How do you comfort your child?'),
      area('discipline_at_home',      'What is the method of behavior management/discipline at home?'),
      area('hopes_for_experience',    'What would you like your child to gain from this childcare experience?'),
      area('anything_else',           'Is there anything else we should know about your child?', { rows: 5 }),

      blockSection('Parent / Guardian Signature'),
      ...typedSignature('parent', 'Parent / Guardian'),
    ],
    notify_emails: [SHREWSBURY_NOTIFY_EMAIL],
  };
}

// ────────────────────────────────────────────────────────────────────
// 4. FOOD ALLERGY & ANAPHYLAXIS EMERGENCY CARE PLAN  (FARE)
// ────────────────────────────────────────────────────────────────────
function fareAnaphylaxisPlan() {
  return {
    slug: 'shrewsbury-fare-anaphylaxis-plan',
    display_name: 'Food Allergy & Anaphylaxis Emergency Care Plan (FARE)',
    description:
      "FARE-standardized emergency care plan for severe food allergies. Requires the child's " +
      'physician / HCP to sign. Upload the signed copy at the bottom.',
    category: 'medical',
    per_student: true,
    confirmation_message:
      "Thanks! Your child's Anaphylaxis Emergency Care Plan is on file with the office. " +
      "The school nurse will review and follow up if anything needs clarification.",
    field_schema: [
      blockHeader('FOOD ALLERGY & ANAPHYLAXIS EMERGENCY CARE PLAN'),
      blockParagraph(
        'NOTE: Do not depend on antihistamines or inhalers (bronchodilators) to treat a severe reaction. USE EPINEPHRINE.',
        'warning',
      ),

      studentPicker(),
      txt('allergy_to', 'Allergy to', { required: true }),
      numF('weight_lbs', 'Weight (lbs)', { required: true }),
      radioF('asthma',
        'Asthma',
        [
          { value: 'yes', label: 'Yes (higher risk for a severe reaction)' },
          { value: 'no',  label: 'No' },
        ],
        { required: true }),

      blockSection('Extremely reactive'),
      txt('extremely_reactive_allergens',
        'Extremely reactive to the following allergens'),
      blockParagraph('THEREFORE:'),
      checkF('likely_eaten_epi',
        'If checked, give epinephrine immediately if the allergen was LIKELY eaten, for ANY symptoms.'),
      checkF('definitely_eaten_epi',
        'If checked, give epinephrine immediately if the allergen was DEFINITELY eaten, even if no symptoms are apparent.'),

      blockSection('FOR ANY OF THE FOLLOWING: SEVERE SYMPTOMS',
        "LUNG: Shortness of breath, wheezing, repetitive cough · HEART: Pale or bluish skin, faintness, weak pulse, dizziness · " +
        'THROAT: Tight or hoarse throat, trouble breathing or swallowing · MOUTH: Significant swelling of the tongue or lips · ' +
        'SKIN: Many hives over body, widespread redness · GUT: Repetitive vomiting, severe diarrhea · ' +
        'OTHER: Feeling something bad is about to happen, anxiety, confusion · OR A COMBINATION of symptoms from different body areas. ' +
        '1. INJECT EPINEPHRINE IMMEDIATELY. 2. Call 911. Tell emergency dispatcher the person is having anaphylaxis and may need epinephrine when emergency responders arrive.'),

      blockSection('MILD SYMPTOMS',
        'NOSE: Itchy or runny nose, sneezing · MOUTH: Itchy mouth · SKIN: A few hives, mild itch · GUT: Mild nausea or discomfort. ' +
        'FOR MILD SYMPTOMS FROM MORE THAN ONE SYSTEM AREA, GIVE EPINEPHRINE. ' +
        'FOR MILD SYMPTOMS FROM A SINGLE SYSTEM AREA: ' +
        '1. Antihistamines may be given, if ordered by a healthcare provider. ' +
        '2. Stay with the person; alert emergency contacts. ' +
        '3. Watch closely for changes. If symptoms worsen, give epinephrine.'),

      blockSection('MEDICATIONS / DOSES'),
      txt('epinephrine_brand', 'Epinephrine Brand or Generic'),
      radioF('epinephrine_dose',
        'Epinephrine Dose',
        ['0.1 mg IM', '0.15 mg IM', '0.3 mg IM']),
      txt('antihistamine_brand', 'Antihistamine Brand or Generic'),
      txt('antihistamine_dose',  'Antihistamine Dose'),
      txt('other_meds',          'Other (e.g., inhaler-bronchodilator if wheezing)'),

      blockSection('OTHER DIRECTIONS / INFORMATION',
        'May self-carry epinephrine, may self-administer epinephrine, etc.'),
      area('other_directions', 'Other directions / information'),

      blockSection('EMERGENCY CONTACTS — CALL 911'),
      txt('rescue_squad',     'RESCUE SQUAD'),
      txt('doctor_name',      'DOCTOR'),
      tel('doctor_phone',     'DOCTOR — PHONE'),
      txt('parent_name',      'PARENT/GUARDIAN'),
      tel('parent_phone',     'PARENT/GUARDIAN — PHONE'),

      blockSection('OTHER EMERGENCY CONTACTS'),
      txt('other_contact_1_name_relationship', 'NAME/RELATIONSHIP (Contact #1)'),
      tel('other_contact_1_phone',             'PHONE (Contact #1)'),
      txt('other_contact_2_name_relationship', 'NAME/RELATIONSHIP (Contact #2)'),
      tel('other_contact_2_phone',             'PHONE (Contact #2)'),

      blockSection('Upload signed copy',
        "Your physician / HCP signs the original. Please upload a scan or photo of the signed plan."),
      fileF('signed_plan_upload', 'Upload signed FARE Emergency Care Plan (PDF / image)',
        { required: false, accept: 'application/pdf,image/*' }),

      blockSection('Patient or Parent / Guardian Authorization Signature'),
      ...typedSignature('parent', 'Patient or Parent / Guardian'),
    ],
    notify_emails: [SHREWSBURY_NOTIFY_EMAIL],
  };
}

// ────────────────────────────────────────────────────────────────────
// 5. INDIVIDUAL HEALTH CARE PLAN  (chronic condition)
// ────────────────────────────────────────────────────────────────────
function ihcp() {
  return {
    slug: 'shrewsbury-ihcp',
    display_name: 'Individual Health Care Plan',
    description:
      "Individual Health Care Plan (IHCP) for a child with a chronic health condition. Requires " +
      "the child's Licensed Health Care Practitioner to fill in clinical details and sign.",
    category: 'medical',
    per_student: true,
    confirmation_message:
      "Thanks! Your child's Individual Health Care Plan is on file with the office. " +
      "The school nurse + program administrator will review.",
    field_schema: [
      blockHeader('Individual Health Care Plan Form'),
      blockParagraph('Growing Bright Minds from Age 15 Months Through Grade Six · Established in 1972, Celebrating 50 Years'),

      studentPicker(),

      blockSection('Plan'),
      txt('condition_name',
        'Name of chronic health care condition', { required: true }),
      area('condition_description',
        'Description of chronic health care condition', { required: true, rows: 4 }),
      area('symptoms',
        'Symptoms', { required: true, rows: 4 }),
      area('treatment_at_program',
        'Medical treatment necessary while at the program', { required: true, rows: 4 }),
      area('trained_administrator',
        'Who has been trained and will be administering this treatment while the child is at the program',
        { required: true, rows: 3 }),
      area('side_effects',
        'Potential side effects of treatment', { required: true, rows: 3 }),
      area('consequences_if_not_administered',
        'Potential consequences if treatment is not administered', { required: true, rows: 3 }),
      area('other_recommendations',
        '(Optional) Other recommendations (e.g., further tests, treatments, mitigating measures, accommodations required to allow for the child\'s full participation, etc.)',
        { rows: 3 }),

      blockSection('Licensed Health Care Practitioner'),
      txt('hcp_name_phone',
        'Name and Phone Number of Licensed Health Care Practitioner (please print)', { required: true }),

      blockSection('Upload signed copy',
        "Your child's healthcare practitioner signs the original. Please upload a scan or photo of the signed plan."),
      fileF('signed_plan_upload', 'Upload signed Individual Health Care Plan (PDF / image)',
        { required: false, accept: 'application/pdf,image/*' }),

      blockSection('Parent / Guardian Signature'),
      ...typedSignature('parent', 'Parent / Guardian'),
    ],
    notify_emails: [SHREWSBURY_NOTIFY_EMAIL],
  };
}

// ────────────────────────────────────────────────────────────────────
// 6. MEDICATION ORDER FORM  (Part A provider, Part B parent)
// ────────────────────────────────────────────────────────────────────
function medicationOrder() {
  return {
    slug: 'shrewsbury-medication-order',
    display_name: 'Medication Order Form',
    description:
      "Medication Order Form for any prescription medication a parent wants administered at " +
      "school. Part A is filled by the child's Healthcare Provider; Part B is filled by the " +
      "parent. Upload the provider-signed Part A at the bottom.",
    category: 'medical',
    per_student: true,
    confirmation_message:
      "Thanks! Your child's Medication Order Form is on file. The school nurse will review " +
      "and reach out if anything needs clarification.",
    field_schema: [
      blockHeader('MEDICATION ORDER FORM'),
      blockParagraph('Growing Bright Minds from Age 15 Months Through Grade Six · Established in 1972, Celebrating 50 Years'),

      studentPicker(),

      blockSection('Part A: To be completed by a Healthcare Provider'),
      txt('diagnosis',         'Diagnosis',                        { required: true }),
      txt('medication_name',   'Name of Medication',               { required: true }),
      area('indications',      'Indications to take Medication',   { required: true }),
      txt('dose',              'Dose',                             { required: true }),
      txt('route',             'Route',                            { required: true }),
      txt('frequency',         'Frequency',                        { required: true }),
      txt('time',              'Time',                             { required: true }),
      area('other_conditions_or_allergies',
        'Any other medical condition or allergies'),
      area('side_effects',
        'Possible Side Effects or Adverse Reactions'),
      area('other_meds',
        'Other medications being taken by the student'),
      radioF('self_administration',
        'Self-administration (if applicable)',
        ['YES', 'NO']),
      txt('hcp_signature_typed',
        'Signature of Health Care Provider (typed full name)'),
      dateF('hcp_signature_date', 'Date'),
      tel('hcp_phone', 'Phone'),

      blockSection('Upload provider-signed Part A',
        "Please upload a scan or photo of the provider-signed Medication Order Form."),
      fileF('signed_order_upload', 'Upload signed Medication Order (PDF / image)',
        { required: false, accept: 'application/pdf,image/*' }),

      blockSection('Part B: To be Completed by a Parent',
        'Please pick YES or NO for each of the three permissions below.'),
      radioF('parent_perm_administer',
        'I give permission for the school nurse or a trained staff member to assist/ administer this medication.',
        ['YES', 'NO'],
        { required: true }),
      radioF('parent_perm_info_share',
        "I give permission to the school nurse to share information relevant to my child's prescribed medication, as necessary to ensure my child's health and safety.",
        ['YES', 'NO'],
        { required: true }),
      radioF('parent_perm_self_admin',
        'I give permission for my child to self-administer this medication at school, as authorized by the licensed prescriber. I understand the school nurse will assess my child\'s ability to do this safely and may implement appropriate supervision or revoke this privilege if safety concerns arise.',
        ['YES', 'NO'],
        { required: true }),

      blockSection('Parent Signature'),
      ...typedSignature('parent', 'Parent'),
      tel('parent_phone', 'Phone', { required: true }),
    ],
    notify_emails: [SHREWSBURY_NOTIFY_EMAIL],
  };
}

// ────────────────────────────────────────────────────────────────────
// 7. OVER-THE-COUNTER MEDICATION STANDING ORDERS
// ────────────────────────────────────────────────────────────────────
function otcStandingOrders() {
  return {
    slug: 'shrewsbury-otc-standing-orders',
    display_name: 'Over-the-Counter Medication Standing Orders',
    description:
      "Standing-order consent for the school nurse to administer common over-the-counter " +
      "medications only as needed according to age/weight and per label direction.",
    category: 'medical',
    per_student: true,
    confirmation_message:
      "Thanks! Your OTC standing-orders consent is on file with the school nurse.",
    field_schema: [
      blockHeader('Over-the-Counter Medication Standing Orders'),
      blockParagraph('Growing Bright Minds from Age 15 Months Through Grade Six · Established in 1972, Celebrating 50 Years'),

      studentPicker(),
      txt('allergies', '***** Allergies', { required: true }),
      numF('age',    'Age',    { required: true }),
      numF('weight', 'Weight', { required: true }),

      blockSection('Permission',
        'I give permission to the School Nurse to administer the following medications/treatment only as needed according to age/weight and per label direction.'),
      blockParagraph('Please check all that apply:'),
      multiF('otc_meds',
        'OTC medications / treatments allowed',
        [
          'Acetaminophen (Tylenol)',
          'Ibuprofen (Advil, Motrin)',
          'Diphenhydramine HCL (Benadryl)',
          'Chewable Antacid Tablets (Tums)',
          'Anti itch creams (Calamine, Hydrocortisone)',
          'Ointment (Bacitracin, Neosporin)',
          'Vaseline',
          'Saline eye drops (eye irritation)',
          'Throat Lozenges',
          'Sting relief (for insect bite or sting)',
          'Bug Spray on field trips',
          'Diaper Cream (if provided by parent)',
          'Sun Block (S.P.F)',
          'Aloe Vera Gel',
        ]),

      blockSection('Consent'),
      radioF('consent_choice',
        'Pick one',
        [
          { value: 'all',    label: 'I/we agree that my child may be given all of the above medications/treatments by the School Nurse as indicated.' },
          { value: 'none',   label: 'I do not want my child to receive any of the above medications/ treatments.' },
          { value: 'except', label: 'I agree that my child may be give all of the above medications EXCEPT FOR:' },
        ],
        { required: true }),
      txt('except_for', 'If EXCEPT FOR: list the medications excluded'),

      blockSection('Signed'),
      ...typedSignature('parent', 'Parent / Guardian'),
    ],
    notify_emails: [SHREWSBURY_NOTIFY_EMAIL],
  };
}

// ────────────────────────────────────────────────────────────────────
// 8. FIRST AID & EMERGENCY MEDICAL CARE CONSENT  (annual, valid 1 yr)
// ────────────────────────────────────────────────────────────────────
function firstAidConsent() {
  return {
    slug: 'shrewsbury-first-aid-consent',
    display_name: 'First Aid & Emergency Medical Care Consent',
    description:
      "Annual consent authorizing SMS staff to administer first aid / CPR and to transport " +
      "your child to a medical facility in an emergency if you can't be reached. Valid for one year.",
    category: 'medical',
    per_student: true,
    confirmation_message:
      "Thanks! Your First Aid & Emergency Medical Care Consent is on file with the office.",
    field_schema: [
      blockHeader('FIRST AID AND EMERGENCY MEDICAL CARE CONSENT FORM'),
      blockParagraph('Growing Bright Minds from Age 15 Months Through Grade Six · Established in 1972, Celebrating 50 Years'),

      studentPicker(),

      blockParagraph(
        'I authorize staff in the child care program who are trained in the basics of first aid/CPR to give my child first aid/CPR when appropriate.',
      ),
      blockParagraph(
        'I understand that every effort will be made to contact me in the event of an emergency requiring medical attention for my child. ' +
        'However, if I cannot be reached, I hereby authorize the program to transport my child to the nearest medical care facility and/or to the facility named below, and to secure necessary medical treatment for my child.',
      ),
      txt('alternate_medical_facility',
        'Alternate medical care facility (if any)', { required: false }),

      blockSection('Physician'),
      txt('physician_name',    "Child's Physician",        { required: true }),
      tel('physician_phone',   'Phone',                    { required: true }),
      area('physician_address','Address', { rows: 2,      required: true }),

      blockSection("Child's health"),
      area('child_allergies',          "Child's Allergies",            { rows: 2 }),
      area('child_chronic_conditions', 'Chronic Health Conditions',    { rows: 2 }),
      area('child_other_health_info',  'Any other important Health Information', { rows: 3 }),

      blockSection('Emergency Contacts (In order to be contacted)'),
      txt('ec1_name', 'Name (Emergency Contact #1)',                          { required: true }),
      area('ec1_address', 'Address (Emergency Contact #1)', { rows: 2 }),
      txt('ec1_relationship', 'Relationship to child (Emergency Contact #1)', { required: true }),
      tel('ec1_home_phone',  'Home Phone (Emergency Contact #1)'),
      tel('ec1_cell',        'Cell (Emergency Contact #1)',                   { required: true }),
      radioF('ec1_release_permission',
        'Permission for child to be released to this person? (Emergency Contact #1)',
        ['Yes', 'No'],
        { required: true }),

      txt('ec2_name', 'Name (Emergency Contact #2)'),
      area('ec2_address', 'Address (Emergency Contact #2)', { rows: 2 }),
      txt('ec2_relationship', 'Relationship to child (Emergency Contact #2)'),
      tel('ec2_home_phone',  'Home Phone (Emergency Contact #2)'),
      tel('ec2_cell',        'Cell (Emergency Contact #2)'),
      radioF('ec2_release_permission',
        'Permission for child to be released to this person? (Emergency Contact #2)',
        ['Yes', 'No']),

      txt('ec3_name', 'Name (Emergency Contact #3)'),
      area('ec3_address', 'Address (Emergency Contact #3)', { rows: 2 }),
      txt('ec3_relationship', 'Relationship to child (Emergency Contact #3)'),
      tel('ec3_home_phone',  'Home Phone (Emergency Contact #3)'),
      tel('ec3_cell',        'Cell (Emergency Contact #3)'),
      radioF('ec3_release_permission',
        'Permission for child to be released to this person? (Emergency Contact #3)',
        ['Yes', 'No']),

      blockSection('Insurance'),
      txt('insurance_coverage', 'Health Insurance Coverage', { required: true }),
      txt('insurance_policy',   'Policy #',                  { required: true }),

      blockSection('Parents / Guardians'),
      txt('parent1_name',  'Parent/Guardian Name (#1)', { required: true }),
      tel('parent1_phone', 'Phone (#1)',                { required: true }),
      tel('parent1_cell',  'Cell (#1)',                 { required: true }),
      txt('parent2_name',  'Parent/Guardian Name (#2)'),
      tel('parent2_phone', 'Phone (#2)'),
      tel('parent2_cell',  'Cell (#2)'),

      blockSection('Parent / Guardian Signature',
        'Valid for one year — please resubmit annually.'),
      ...typedSignature('parent', 'Parent / Guardian'),
    ],
    notify_emails: [SHREWSBURY_NOTIFY_EMAIL],
  };
}

// ────────────────────────────────────────────────────────────────────
// FORMS index
// ────────────────────────────────────────────────────────────────────
const FORMS = [
  asthmaActionPlan(),
  eecTransportation(),
  eecDevelopmental(),
  fareAnaphylaxisPlan(),
  ihcp(),
  medicationOrder(),
  otcStandingOrders(),
  firstAidConsent(),
];

// ────────────────────────────────────────────────────────────────────
// main — upsert, seed as DRAFT (is_active=false)
// ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Seeding ${FORMS.length} parent-portal forms for Shrewsbury Montessori`);
  console.log(`Notify default: ${SHREWSBURY_NOTIFY_EMAIL} (editable per-form via the form editor)`);
  console.log(`All seeded as DRAFT (is_active=false) — flip to Published from the Forms tab after preview.\n`);

  let created = 0, updated = 0, gated = 0;
  for (const f of FORMS) {
    const existing = await pool.query(
      `SELECT id, needs_review FROM portal_form_definitions
        WHERE school_id = $1 AND slug = $2`,
      [SHREWSBURY_SCHOOL_ID, f.slug],
    );

    if (existing.rowCount === 0) {
      await pool.query(
        `INSERT INTO portal_form_definitions
           (school_id, slug, display_name, description, category, per_student,
            is_active, needs_review, allow_addendum, resubmission_allowed,
            one_submission_per_year,
            field_schema, ghl_writeback, notify_emails, webhook_urls,
            confirmation_message, audience)
         VALUES ($1,$2,$3,$4,$5,$6,
                 false, true, false, true, false,
                 $7::jsonb, '[]'::jsonb, $8::text[], '{}'::text[],
                 $9, 'parents')`,
        [SHREWSBURY_SCHOOL_ID, f.slug, f.display_name, f.description, f.category, f.per_student,
         JSON.stringify(f.field_schema), f.notify_emails, f.confirmation_message],
      );
      console.log(`  ✓ created ${f.slug}  (DRAFT — review in portal before publishing)`);
      created++;
      continue;
    }
    if (existing.rows[0].needs_review === false && !args.refresh) {
      console.log(`  ⊝ skipped ${f.slug} (already curated; pass --refresh to override)`);
      gated++;
      continue;
    }
    await pool.query(
      `UPDATE portal_form_definitions
          SET display_name = $3, description = $4, category = $5, per_student = $6,
              field_schema = $7::jsonb, notify_emails = $8::text[],
              confirmation_message = $9, audience = 'parents',
              needs_review = false,
              updated_at = now()
        WHERE school_id = $1 AND slug = $2`,
      [SHREWSBURY_SCHOOL_ID, f.slug, f.display_name, f.description, f.category, f.per_student,
       JSON.stringify(f.field_schema), f.notify_emails, f.confirmation_message],
    );
    console.log(`  ↻ updated ${f.slug}`);
    updated++;
  }

  console.log(`\nDone. ${created} created, ${updated} updated, ${gated} skipped.`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => pool.end());
