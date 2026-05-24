// Seed 8 portal-form definitions for Montessori School of Wooster.
//
// Schemas are derived from analysis of the 818 historical CSV submissions.
// Field types are inferred from sample values; required vs optional is best
// guess for now (operator can adjust).
//
// Every form has resubmission_allowed = true so parents who want to
// update their previous answers can do so freely.
//
// Each form is wired to a legacy_completion_field_key — a GHL custom field
// on the parent's contact (or per-student slot pattern for per-student
// forms) that the renderer reads to decide whether to show the
// "Complete · submitted via legacy form" lock state.

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
  if (!process.env[t.slice(0, eq).trim()]) process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
}

const WOOSTER_SCHOOL_ID = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── Common shared blocks ────────────────────────────────────────────────

const SIGNATURE_BLOCKS = [
  {
    type: 'signature_drawn',
    key: 'parent_signature',
    label: 'Parent / guardian signature',
    required: true,
  },
  {
    type: 'date',
    key: 'signature_date',
    label: 'Date signed',
    required: true,
    prefill: 'today',
  },
];

// ── The 8 forms ─────────────────────────────────────────────────────────

const FORMS = [
  // ─── FAMILY-LEVEL (3) ───
  {
    slug: 'emergency-medical',
    legacy_form_id: 'ZYkoa8s2oogcuu7FjoLK',
    display_name: 'Emergency Medical Information',
    description:
      'Emergency contact, doctor, hospital, and insurance information for your family. '
      + 'Please review and update if anything has changed since you last submitted.',
    category: 'medical',
    per_student: false,
    legacy_completion_field_key: 'form_emergency_medical_complete',
    field_schema: [
      { type: 'header', text: 'Emergency Medical Information' },

      { type: 'section', label: 'Emergency Contact #1', description: 'First person to call if we cannot reach a parent.' },
      { type: 'text', key: 'ec1_name', label: 'Name', required: true, width: 'half' },
      { type: 'text', key: 'ec1_relationship', label: 'Relationship to student', required: true, width: 'half' },
      { type: 'tel', key: 'ec1_phone', label: 'Phone', required: true, width: 'half' },

      { type: 'section', label: 'Emergency Contact #2 (optional)', description: 'A backup if we can\'t reach Contact #1.' },
      { type: 'text', key: 'ec2_name', label: 'Name', width: 'half' },
      { type: 'text', key: 'ec2_relationship', label: 'Relationship to student', width: 'half' },
      { type: 'tel', key: 'ec2_phone', label: 'Phone', width: 'half' },

      { type: 'section', label: 'Emergency Contact #3 (optional)', description: 'A third option — useful if a grandparent or family friend may pick up.' },
      { type: 'text', key: 'ec3_name', label: 'Name', width: 'half' },
      { type: 'text', key: 'ec3_relationship', label: 'Relationship to student', width: 'half' },
      { type: 'tel', key: 'ec3_phone', label: 'Phone', width: 'half' },

      { type: 'section', label: 'Insurance' },
      { type: 'text', key: 'insurance_company', label: 'Insurance Company', width: 'half' },
      { type: 'text', key: 'insurance_policy', label: 'Policy Number', width: 'half' },
      { type: 'text', key: 'insurance_holder', label: "Policy Holder's Name", width: 'full' },

      { type: 'section', label: 'Medical Providers' },
      { type: 'text', key: 'doctor_name', label: 'Doctor Name', width: 'half' },
      { type: 'tel', key: 'doctor_phone', label: 'Doctor Phone', width: 'half' },
      { type: 'text', key: 'dentist_name', label: 'Dentist Name', width: 'half' },
      { type: 'tel', key: 'dentist_phone', label: 'Dentist Phone', width: 'half' },
      { type: 'text', key: 'specialist_name', label: 'Medical Specialist Name', width: 'half' },
      { type: 'tel', key: 'specialist_phone', label: 'Medical Specialist Phone', width: 'half' },
      { type: 'text', key: 'hospital_name', label: 'Preferred Hospital', width: 'half' },
      { type: 'tel', key: 'hospital_phone', label: 'Hospital Phone', width: 'half' },

      { type: 'section', label: 'Consent for Emergency Treatment' },
      {
        type: 'radio',
        key: 'emergency_consent',
        label: 'In the event of an emergency, do you grant or refuse to grant consent for treatment for your child?',
        required: true,
        options: [
          { value: 'grant', label: 'Yes, grant consent for treatment' },
          { value: 'refuse', label: 'Refuse consent for treatment' },
        ],
      },

      { type: 'section', label: 'Existing Conditions & Medications' },
      { type: 'textarea', key: 'existing_conditions', label: 'Existing Medical Conditions', rows: 2 },
      { type: 'textarea', key: 'current_medications', label: 'Current Medications', rows: 2 },
      { type: 'textarea', key: 'allergies', label: 'Allergies', rows: 2 },

      { type: 'section', label: 'Signature' },
      ...SIGNATURE_BLOCKS,
    ],
    ghl_writeback: [
      { field_key: 'ec1_name', ghl_field_key: 'emergency_contact_1_name' },
      { field_key: 'ec1_phone', ghl_field_key: 'emergency_contact_1_phone_numbers' },
      { field_key: 'ec1_relationship', ghl_field_key: 'emergency_contact_1_relationship' },
      { field_key: 'ec2_name', ghl_field_key: 'emergency_contact_2_name' },
      { field_key: 'ec2_phone', ghl_field_key: 'emergency_contact_2_phone_numbers' },
      { field_key: 'ec3_name', ghl_field_key: 'emergency_contact_3_name' },
      { field_key: 'ec3_phone', ghl_field_key: 'emergency_contact_3_phone_numbers' },
      { field_key: 'doctor_name', ghl_field_key: 'doctor_name' },
      { field_key: 'doctor_phone', ghl_field_key: 'doctor_phone' },
      { field_key: 'hospital_name', ghl_field_key: 'hospital_name' },
      { field_key: 'allergies', ghl_field_key: 'allergies' },
      { field_key: 'current_medications', ghl_field_key: 'medications' },
      { field_key: 'signature_date', ghl_field_key: 'form_emergency_medical_complete' },
    ],
  },

  {
    slug: 'media-permission',
    legacy_form_id: 'WQq9S2p4m8W9G2m1P0zb',
    display_name: 'Media & Roster Permissions',
    description:
      'Two related permissions: whether the school may feature your child in photos / '
      + 'media, and whether your contact info can appear on the school-wide parent roster '
      + '(required by Ohio preschool licensing to be asked).',
    category: 'release',
    per_student: false,
    legacy_completion_field_key: 'form_media_permission_complete',
    field_schema: [
      { type: 'header', text: 'Media Permission' },
      {
        type: 'paragraph',
        text:
          'Montessori School of Wooster occasionally photographs and films students for use '
          + 'in school publications, newsletters, our website, and social media. Please indicate '
          + 'your preference below.',
        emphasis: 'note',
      },
      {
        type: 'radio',
        key: 'media_grant',
        label: 'I grant permission for my child to appear in school media',
        required: true,
        options: [
          { value: 'yes', label: 'Yes, I grant permission' },
          { value: 'no', label: 'No, I do not grant permission' },
        ],
      },

      { type: 'section', label: 'Parent Roster Authorization', description: 'Required by Ohio preschool licensing — please tell us what you\'re comfortable sharing on the class roster.' },
      {
        type: 'paragraph',
        text:
          'Ohio preschool licensing requires us to give you the option of listing your '
          + 'contact information on the school-wide parent roster, distributed once a year '
          + 'so families can coordinate playdates, carpools, and class events.',
        emphasis: 'note',
      },
      {
        type: 'multi_checkbox',
        key: 'roster_authorize',
        label: 'Check anything you\'d like included on the parent roster (or leave all unchecked to opt out)',
        options: [
          { value: 'parent_name', label: "My name(s)" },
          { value: 'email', label: 'My email address' },
          { value: 'phone', label: 'My phone number' },
          { value: 'address', label: 'My home address' },
          { value: 'student_name', label: "My child's name" },
        ],
      },
      {
        type: 'paragraph',
        text: 'Leave all boxes unchecked if you do NOT want any information on the roster.',
        emphasis: 'note',
      },

      ...SIGNATURE_BLOCKS,
    ],
    ghl_writeback: [
      { field_key: 'media_grant', ghl_field_key: 'media_permission_granted' },
      { field_key: 'roster_authorize', ghl_field_key: 'parent_roster_authorize' },
      { field_key: 'signature_date', ghl_field_key: 'form_media_permission_complete' },
    ],
  },

  {
    slug: 'ode-connectivity',
    legacy_form_id: 'REM1LBxflMG7n4yhY0Eb',
    display_name: 'ODE Connectivity Survey',
    description:
      'Required by the Ohio Department of Education. Tells us what kind of internet '
      + 'connectivity and learning device(s) your family has at home.',
    category: 'registration',
    per_student: false,
    legacy_completion_field_key: 'form_ode_connectivity_complete',
    field_schema: [
      { type: 'header', text: 'ODE Connectivity Survey' },
      {
        type: 'select',
        key: 'internet_connectivity',
        label: 'Do you have internet connectivity in your home?',
        required: true,
        options: [
          { value: 'broadband', label: 'Broadband access from home (cable, DSL, etc.)' },
          { value: 'mobile', label: 'Mobile data / hotspot only' },
          { value: 'none', label: 'No reliable internet at home' },
        ],
      },
      {
        type: 'select',
        key: 'device_type',
        label: 'What type of device do you have available in your home for remote learning?',
        required: true,
        options: [
          { value: 'computer', label: 'A laptop, desktop or tablet computer available' },
          { value: 'phone_only', label: 'A smartphone only' },
          { value: 'none', label: 'No device available' },
        ],
      },
      ...SIGNATURE_BLOCKS,
    ],
    ghl_writeback: [
      { field_key: 'internet_connectivity', ghl_field_key: 'ode_internet_connectivity' },
      { field_key: 'device_type', ghl_field_key: 'ode_device_type' },
      { field_key: 'signature_date', ghl_field_key: 'form_ode_connectivity_complete' },
    ],
  },

  // ─── PER-STUDENT (5) ───
  {
    slug: 'enrollment-agreement',
    legacy_form_id: 'UI1uIRAmjurmCYSwUDdp',
    display_name: 'Enrollment Agreement',
    description:
      'The annual tuition agreement for each enrolled student. '
      + 'Includes the payment plan you select and the school’s terms and conditions.',
    category: 'legal',
    per_student: true,
    legacy_completion_field_key: 'form_enrollment_agreement_s',
    field_schema: [
      { type: 'header', text: 'Enrollment Agreement' },
      { type: 'text', key: 'student_full_name', label: 'Student name', required: true, prefill: 'student.full_name' },
      {
        type: 'select',
        key: 'payment_plan',
        label: 'The Parent(s) agree to pay the above tuition (minus the $300 deposit) using the following plan:',
        required: true,
        options: [
          { value: 'annual', label: 'Annual — single payment' },
          { value: 'biannual', label: '2 equal payments (semi-annual)' },
          { value: 'quarterly', label: '4 equal quarterly payments' },
          { value: 'monthly_9', label: '9 monthly payments' },
          { value: 'monthly_10', label: '10 monthly payments' },
          { value: 'ed_choice', label: 'Ed Choice Scholarship, applicable balance billed' },
          { value: 'other', label: 'Other — please describe in exceptions below' },
        ],
      },
      { type: 'textarea', key: 'plan_exceptions', label: 'Please list any exceptions to the above plan (optional)', rows: 2 },
      {
        type: 'checkbox',
        key: 'agree_terms',
        label: 'I have read and agree to the Terms and Conditions of enrollment.',
        required: true,
      },
      ...SIGNATURE_BLOCKS,
    ],
    ghl_writeback: [
      { field_key: 'payment_plan', ghl_field_key: 'enrollment_payment_plan_s{slot}', per_student: true },
      { field_key: 'signature_date', ghl_field_key: 'form_enrollment_agreement_s{slot}', per_student: true },
    ],
  },

  {
    slug: 'health-history',
    legacy_form_id: 'WB996PpkIOHsNA09ujii',
    display_name: 'Health History',
    description:
      'Birth, developmental, and overall health history for each student. '
      + 'Helps us understand any special needs or concerns.',
    category: 'medical',
    per_student: true,
    legacy_completion_field_key: 'form_health_history_s',
    field_schema: [
      { type: 'header', text: 'Health History' },
      { type: 'text', key: 'student_full_name', label: 'Student name', required: true, prefill: 'student.full_name' },
      {
        type: 'textarea',
        key: 'incomplete_history_reason',
        label: 'If you do NOT have a complete medical history for this student, please explain why (but still complete the following to the best of your ability)',
        rows: 2,
      },
      {
        type: 'textarea',
        key: 'birth_developmental',
        label: 'Birth & Developmental History',
        rows: 4,
        help: 'Any details about pregnancy, birth, or early development relevant to the school knowing.',
      },
      {
        type: 'textarea',
        key: 'special_needs',
        label: 'Special Needs or Disability',
        rows: 3,
        help: 'IEP, 504, learning differences, etc.',
      },
      ...SIGNATURE_BLOCKS,
    ],
    ghl_writeback: [
      { field_key: 'signature_date', ghl_field_key: 'form_health_history_s{slot}', per_student: true },
    ],
  },

  {
    slug: 'health-conditions',
    legacy_form_id: 'Ay7JhvpgynDUY1mFPcZX',
    display_name: 'Health Conditions',
    description:
      'A quick checklist of medical conditions for each student. Most boxes will be No — '
      + 'please confirm the ones that apply.',
    category: 'medical',
    per_student: true,
    legacy_completion_field_key: 'form_health_conditions_s',
    field_schema: [
      { type: 'header', text: 'Health Conditions' },
      { type: 'text', key: 'student_full_name', label: 'Student name', required: true, prefill: 'student.full_name' },

      { type: 'section', label: 'Allergies' },
      yesNo('add_adhd', 'ADD/ADHD'),
      yesNo('allergy_insect', 'Severe Stinging Insect Allergies (if local only, just note in the list below)'),
      yesNo('allergy_food', 'Food Allergies'),
      yesNo('allergy_pollen', 'Pollen Allergy'),
      yesNo('allergy_latex', 'Latex Allergy'),
      yesNo('allergy_medication', 'Medication Allergy'),
      yesNo('has_anaphylaxis', 'Has Anaphylaxis Reaction (Breathing Difficulties)'),
      yesNo('has_epipen', 'Has Epipen'),
      { type: 'textarea', key: 'allergies_list', label: 'List all allergens (medicines, foods, stinging insects, plants, animals, environmental, etc.)', rows: 2 },

      { type: 'section', label: 'Conditions' },
      yesNo('asthma', 'Asthma'),
      yesNo('diabetes', 'Diabetes'),
      yesNo('seizures', 'Seizures/Epilepsy'),
      yesNo('vision_problems', 'Vision Problems'),
      yesNo('wears_glasses', 'Wears Glasses or Contacts'),
      yesNo('hearing_problems', 'Hearing Problems'),
      yesNo('ear_infections', 'Ear Infections (frequently after age 3)'),
      yesNo('heart_condition', 'Heart Condition'),
      yesNo('kidney_disease', 'Kidney Disease'),
      yesNo('enlarged_spleen', 'Enlarged Spleen'),
      yesNo('bladder_problems', 'Bladder Problems'),
      yesNo('bowel_problems', 'Bowel Problems'),
      yesNo('missing_organs', 'Missing/Malfunctioning Organs (kidney, eye, testicle (males), spleen, etc.)'),
      yesNo('cystic_fibrosis', 'Cystic Fibrosis'),
      yesNo('osteopenia', 'Osteopenia or Osteoporosis'),
      yesNo('spinal_issues', 'Spinal Issues (scoliosis, etc.)'),
      yesNo('spina_bifida', 'Spina Bifida'),
      yesNo('muscle_spasticity', 'Muscle Spasticity'),
      yesNo('numbness', 'Numbness (arms, hands, legs, or feet)'),
      yesNo('weakness', 'Weakness (arms, hands, legs, or feet)'),
      yesNo('blood_disorder', 'Blood Disorder'),
      yesNo('hepatitis', 'Hepatitis'),
      yesNo('tics', 'Tics / Nervous Twitches'),
      yesNo('emotional_behavioral', 'Emotional / Behavioral Concerns'),
      { type: 'textarea', key: 'other_health_info', label: "Please list any other health information, questions, or concerns relevant to your child's safety", rows: 3 },

      ...SIGNATURE_BLOCKS,
    ],
    ghl_writeback: [
      { field_key: 'signature_date', ghl_field_key: 'form_health_conditions_s{slot}', per_student: true },
    ],
  },

  {
    slug: 'medications',
    legacy_form_id: 'uA8aMpHrjf73nCMGsxPT',
    display_name: 'Medications',
    description:
      'Medications each student takes, and (if applicable) the medical administration '
      + 'form authorizing school staff to administer them.',
    category: 'medical',
    per_student: true,
    legacy_completion_field_key: 'form_medications_s',
    field_schema: [
      { type: 'header', text: 'Medications' },
      { type: 'text', key: 'student_full_name', label: 'Student name', required: true, prefill: 'student.full_name' },
      {
        type: 'textarea',
        key: 'medications_list',
        label: 'Current medications, doses, and reasons',
        rows: 3,
        help: 'Include any over-the-counter medications taken regularly. Write "None" if not applicable.',
        required: true,
      },
      {
        type: 'file_upload',
        key: 'medical_admin_form',
        label: 'Medical Administration Form (if you want the school to administer medication)',
        accept: 'application/pdf,image/*',
        help: 'Required if you are requesting the school to administer any medication. Upload the signed form (PDF or photo).',
      },
      ...SIGNATURE_BLOCKS,
    ],
    ghl_writeback: [
      { field_key: 'medications_list', ghl_field_key: 'student_{slot}_medications', per_student: true },
      { field_key: 'signature_date', ghl_field_key: 'form_medications_s{slot}', per_student: true },
    ],
  },

  {
    slug: 'injury-history',
    legacy_form_id: 'r9bL02ZYgQwy4ywqQtN6',
    display_name: 'Injury History',
    description:
      'Past surgeries, hospital stays, and significant injuries for each student.',
    category: 'medical',
    per_student: true,
    legacy_completion_field_key: 'form_injury_history_s',
    field_schema: [
      { type: 'header', text: 'Injury History' },
      { type: 'text', key: 'student_full_name', label: 'Student name', required: true, prefill: 'student.full_name' },
      yesNo('participation_restricted', "Has a provider ever denied or restricted your child's participation in sports/activities for any reason?"),
      yesNo('had_surgery', 'Has your child ever had surgery or serious injury?'),
      yesNo('spent_night_in_hospital', 'Has your child ever spent the night in the hospital?'),
      {
        type: 'textarea',
        key: 'injury_list',
        label: 'Please list ALL injuries and illnesses that have required medical attention (include years if appropriate)',
        rows: 4,
      },
      ...SIGNATURE_BLOCKS,
    ],
    ghl_writeback: [
      { field_key: 'signature_date', ghl_field_key: 'form_injury_history_s{slot}', per_student: true },
    ],
  },
];

function yesNo(key, label) {
  return {
    type: 'radio',
    key,
    label,
    options: [
      { value: 'no', label: 'No' },
      { value: 'yes', label: 'Yes' },
    ],
  };
}

async function main() {
  const r = await pool.query('SELECT id, name FROM schools WHERE id = $1', [WOOSTER_SCHOOL_ID]);
  if (r.rowCount === 0) {
    console.error('Wooster school not found');
    process.exit(1);
  }
  console.log(`Seeding portal-forms for ${r.rows[0].name}`);

  let created = 0, updated = 0;
  for (const f of FORMS) {
    const existing = await pool.query(
      'SELECT id FROM portal_form_definitions WHERE school_id = $1 AND slug = $2',
      [WOOSTER_SCHOOL_ID, f.slug],
    );
    if (existing.rowCount === 0) {
      await pool.query(
        `INSERT INTO portal_form_definitions
           (school_id, slug, display_name, description, category, per_student,
            required_for, is_active, field_schema, ghl_writeback,
            one_submission_per_year, resubmission_allowed, needs_review,
            legacy_completion_field_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13, $14)`,
        [
          WOOSTER_SCHOOL_ID, f.slug, f.display_name, f.description, f.category, f.per_student,
          'all', true,
          JSON.stringify(f.field_schema),
          JSON.stringify(f.ghl_writeback),
          true,           // one_submission_per_year
          true,           // resubmission_allowed
          false,          // needs_review (these have real schemas)
          f.legacy_completion_field_key,
        ],
      );
      console.log(`  ✓ created ${f.slug}`);
      created++;
    } else {
      await pool.query(
        `UPDATE portal_form_definitions
            SET display_name = $3,
                description = $4,
                category = $5,
                per_student = $6,
                field_schema = $7::jsonb,
                ghl_writeback = $8::jsonb,
                resubmission_allowed = true,
                legacy_completion_field_key = $9,
                updated_at = now()
          WHERE school_id = $1 AND slug = $2`,
        [
          WOOSTER_SCHOOL_ID, f.slug,
          f.display_name, f.description, f.category, f.per_student,
          JSON.stringify(f.field_schema), JSON.stringify(f.ghl_writeback),
          f.legacy_completion_field_key,
        ],
      );
      console.log(`  ↻ updated ${f.slug}`);
      updated++;
    }
  }
  console.log(`\nDone. ${created} created, ${updated} updated.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => pool.end());
