// Seed DGM's parent-portal forms from the structured inventory brief.
//
// Source of truth: scripts/data/dgm_forms_inventory.json
// Brief & policy decisions: docs/DGM_FORMS_BUILD_BRIEF.md
//
// What this seeder does:
//   1. Loads the JSON inventory
//   2. Skips PARTIAL / BLOCKED forms (no field detail to seed)
//   3. Transforms each form's section/field tree into our portal_form_definitions
//      shape (field_schema jsonb, plus the new migration-040/042 columns)
//   4. Applies the data-quality fixes called out in brief §6:
//        - "Anti Naseau"          -> "Anti Nausea"           (MYHS OTC)
//        - "Hydrocortison Cream"  -> "Hydrocortisone Cream"  (MYHS OTC) (already fixed in JSON)
//        - DGM Golf classroom "High" -> "High School"
//        - Summer "preceeding"  -> "preceding"
//        - Summer Elem "ABSENSES" -> "ABSENCES"
//        - Release of Information signature + date -> required
//        - MYHS OTC allergy: split free-text -> Yes/No radio + conditional follow-up
//        - Staying Safe forms: drop teacher-email dropdown (classroom is enough)
//        - AZ state forms: drop staff-only sections + tracking fields
//        - Sport forms: add explicit FACTS-billing acknowledgment
//   5. Upserts each form by (school_id, slug). Idempotent.
//
// Usage:
//   node scripts/seed-dgm-forms-from-brief.mjs               # uses default DGM school
//   node scripts/seed-dgm-forms-from-brief.mjs --school-id <uuid>
//   node scripts/seed-dgm-forms-from-brief.mjs --refresh     # force-update curated forms
//
// Auth: bypasses the API (direct DB writes via service-role connection).
// Re-runnable; existing field_schemas with needs_review=false are preserved
// unless --refresh is passed.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// ── .env loader (matches other seed scripts) ─────────────────────────
const envText = readFileSync(join(projectRoot, '.env.local'), 'utf8');
for (const line of envText.split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('=');
  if (eq === -1) continue;
  const k = t.slice(0, eq).trim();
  if (!process.env[k]) process.env[k] = t.slice(eq + 1).trim();
}

const args = parseArgs(process.argv.slice(2));
// Default to DGM's known UUID — looked up via scripts/find-dgm-location.mjs.
const DEFAULT_DGM_SCHOOL_ID = 'cfa9030d-c8fe-49ae-a9e7-f1003844ec07';
const schoolId = args.schoolId || DEFAULT_DGM_SCHOOL_ID;

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── Standard consent text used by DGM (brief §5.1) ───────────────────
const DGM_ESIG_CONSENT =
  'By typing my name below I agree to conduct business with Desert Garden ' +
  'Montessori by electronic means. I intend by typing my name below to ' +
  '"sign" the preceding document and to be bound by its terms and conditions.';

// ── Sensible default thank-you message per category ─────────────────
const DEFAULT_CONFIRMATIONS = {
  permission:    'Thanks! Your permission form has been received. The office will reach out only if anything additional is needed.',
  medical:       'Thanks! Your medical authorization has been received and will be on file with the front desk before the medication start date.',
  release:       'Thanks! Your authorization has been received. Karen Hurlbert will reach out to your prior school/provider to request the records.',
  trip:          'Thanks! Your trip permission has been received. Watch your email for trip-day reminders closer to the date.',
  registration:  'Thanks for registering! The fee will be billed through your FACTS account per the schedule above. You\'ll get a confirmation email from athletics or summer programs with next steps.',
  enrollment:    'Thanks! Your form has been received and added to your child\'s file.',
};

// ── Master classroom list (brief §5.2) ───────────────────────────────
const ALL_CLASSROOMS = [
  'CR1', 'CR2', 'CR3', 'CR4', 'CR5', 'CR6', 'CR7', 'CR8',
  'LE CR11', 'LE CR12',
  'UE CR10', 'UE Tower',
  'MS 7 & 8',
  'HS 9, 10, 11 & 12',
];

// ─────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────
async function main() {
  // Resolve school
  const sRes = await pool.query(
    `SELECT id, name, ghl_location_id FROM schools WHERE id = $1`, [schoolId],
  );
  if (sRes.rowCount === 0) {
    console.error(`School ${schoolId} not found.`);
    process.exit(2);
  }
  console.log(`Seeding forms for ${sRes.rows[0].name} (school_id=${schoolId})`);

  const inventoryPath = join(projectRoot, 'scripts/data/dgm_forms_inventory.json');
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));

  let created = 0, updated = 0, skipped = 0, gated = 0;

  for (const sourceForm of inventory.forms) {
    // Skip partial / blocked forms — no field detail to seed.
    if (sourceForm.status && /^(PARTIAL|BLOCKED)/.test(sourceForm.status)) {
      console.log(`  ⊝ skipping ${sourceForm.form_id} (${sourceForm.status.split(' ')[0]})`);
      skipped++;
      continue;
    }

    const built = buildForm(sourceForm);
    if (!built) {
      console.log(`  ⊝ skipping ${sourceForm.form_id} (build returned null)`);
      skipped++;
      continue;
    }

    const existing = await pool.query(
      `SELECT id, needs_review FROM portal_form_definitions
        WHERE school_id = $1 AND slug = $2`,
      [schoolId, built.slug],
    );

    if (existing.rowCount === 0) {
      await pool.query(insertSQL, insertArgs(schoolId, built));
      console.log(`  ✓ created ${built.slug}`);
      created++;
      continue;
    }

    if (existing.rows[0].needs_review === false && !args.refresh) {
      console.log(`  ⊝ skipped ${built.slug} (already curated; pass --refresh to override)`);
      gated++;
      continue;
    }

    await pool.query(updateSQL, updateArgs(schoolId, built));
    console.log(`  ↻ updated ${built.slug}`);
    updated++;
  }

  console.log('');
  console.log(`Done. ${created} created, ${updated} updated, ${gated} curated-skipped, ${skipped} status-skipped.`);
  const tot = await pool.query(
    `SELECT COUNT(*)::int AS n FROM portal_form_definitions WHERE school_id = $1`,
    [schoolId],
  );
  console.log(`Total form definitions for school: ${tot.rows[0].n}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => pool.end());

// ─────────────────────────────────────────────────────────────────────
// SQL helpers
// ─────────────────────────────────────────────────────────────────────
const insertSQL = `
  INSERT INTO portal_form_definitions
    (school_id, slug, display_name, description, category, per_student,
     is_active, needs_review, allow_addendum, resubmission_allowed,
     one_submission_per_year,
     field_schema, ghl_writeback, fee_amount, payment_config,
     confirmation_message, confirmation_redirect_url, notify_emails, webhook_urls)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15::jsonb,$16,$17,$18::text[],$19::text[])`;

const updateSQL = `
  UPDATE portal_form_definitions
     SET display_name = $3, description = $4, category = $5, per_student = $6,
         is_active = $7, needs_review = $8, allow_addendum = $9,
         resubmission_allowed = $10, one_submission_per_year = $11,
         field_schema = $12::jsonb, ghl_writeback = $13::jsonb,
         fee_amount = $14, payment_config = $15::jsonb,
         confirmation_message = $16, confirmation_redirect_url = $17,
         notify_emails = $18::text[], webhook_urls = $19::text[],
         updated_at = now()
   WHERE school_id = $1 AND slug = $2`;

function insertArgs(sid, f) {
  return [
    sid, f.slug, f.display_name, f.description, f.category, f.per_student,
    f.is_active, f.needs_review, f.allow_addendum, f.resubmission_allowed,
    f.one_submission_per_year,
    JSON.stringify(f.field_schema), JSON.stringify(f.ghl_writeback ?? []),
    f.fee_amount, f.payment_config ? JSON.stringify(f.payment_config) : null,
    f.confirmation_message, f.confirmation_redirect_url,
    f.notify_emails ?? [], f.webhook_urls ?? [],
  ];
}
const updateArgs = insertArgs; // same arg order

// ─────────────────────────────────────────────────────────────────────
// Per-form builder dispatch
// ─────────────────────────────────────────────────────────────────────
function buildForm(src) {
  switch (src.form_id) {
    case 'authorization_to_pickup':                    return buildPickupAuthorization(src);
    case 'le_campout_excursion':                       return buildLeCampout(src);
    case 'myhs_otc_medication_consent':                return buildMyhsOtcConsent(src);
    case 'cafe_worker_permission':                     return buildCafeWorker(src);
    case 'fieldtrip_childplay_theater':                return buildChildplayFieldtrip(src);
    case 'lower_e_staying_safe':                       return buildStayingSafe(src, 'le');
    case 'primary_staying_safe':                       return buildStayingSafe(src, 'primary');
    case 'mosquito_repellent_permission':              return buildMosquitoRepellent(src);
    case 'request_administering_medication':           return buildRequestMedication(src);
    case 'dgm_flag_football_registration':             return buildSportRegistration(src, 'flag-football');
    case 'dgm_golf_registration':                      return buildSportRegistration(src, 'golf');
    case 'dgm_pickle_ball_registration':               return buildSportRegistration(src, 'pickleball');
    case 'spartan_registration':                       return buildSpartanRegistration(src);
    case 'authorization_for_release_of_information':   return buildRecordsRelease(src);
    case 'state_emergency_info_immunization_card':     return buildStateEmergencyCard(src);
    case 'state_medication_consent':                   return buildStateMedicationConsent(src);
    case 'summer_registration_itp_2026':               return buildSummerItp(src);
    case 'summer_registration_elementary_2026':        return buildSummerElementary(src);
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Reusable field generators (brief §5)
// ─────────────────────────────────────────────────────────────────────
function blockHeader(text)  { return { type: 'header',    text }; }
function blockSection(label, description) {
  return description
    ? { type: 'section', label, description }
    : { type: 'section', label };
}
function blockParagraph(text, emphasis) {
  return emphasis
    ? { type: 'paragraph', text, emphasis }
    : { type: 'paragraph', text };
}
function txt(key, label, opts = {})       { return { type: 'text', key, label, ...opts }; }
function area(key, label, opts = {})      { return { type: 'textarea', key, label, rows: 3, ...opts }; }
function email(key, label, opts = {})     { return { type: 'email', key, label, ...opts }; }
function phone(key, label, opts = {})     { return { type: 'tel', key, label, ...opts }; }
function dateF(key, label, opts = {})     { return { type: 'date', key, label, ...opts }; }
function selectF(key, label, options, opts = {}) {
  return { type: 'select', key, label,
    options: options.map((v) => typeof v === 'string' ? { value: keyify(v), label: v } : v),
    ...opts };
}
function radioF(key, label, options, opts = {}) {
  return { type: 'radio', key, label,
    options: options.map((v) => typeof v === 'string' ? { value: keyify(v), label: v } : v),
    ...opts };
}
function multi(key, label, options, opts = {}) {
  return { type: 'multi_checkbox', key, label,
    options: options.map((v) => typeof v === 'string' ? { value: keyify(v), label: v } : v),
    ...opts };
}
function checkboxF(key, label, opts = {}) {
  return { type: 'checkbox', key, label, ...opts };
}
function fileF(key, label, opts = {})     { return { type: 'file_upload', key, label, max_size_mb: 10, ...opts }; }

// The standard DGM e-signature block: a typed-name signature + email + date.
// Brief §5.1 says this is reused everywhere.
function eSignatureBlock(opts = {}) {
  const acknowledgment = opts.acknowledgment || DGM_ESIG_CONSENT;
  const requireEmail = opts.requireEmail !== false;
  return [
    blockSection('Parent signature', opts.descriptionOverride ?? null),
    {
      type: 'signature_typed',
      key: 'parent_signature',
      label: 'Parent signature (type your full name)',
      acknowledgment,
      required: true,
    },
    ...(requireEmail ? [email('parent_email', 'Parent email', { required: true })] : []),
    dateF('signed_at', 'Date', { required: true }),
  ];
}

// snake_case-ish field key from a human label. Truncated to keep DB
// keys reasonable.
function keyify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

// ─────────────────────────────────────────────────────────────────────
// FORM BUILDERS (one per source form)
// ─────────────────────────────────────────────────────────────────────

function buildPickupAuthorization(src) {
  const field_schema = [
    blockHeader('Authorization to Pick Up'),
    blockParagraph(src.description, 'note'),

    blockSection('Parent & student info'),
    txt('parent_name', 'Parent name', { required: true }),
    email('parent_email', 'Parent email', { required: true }),
    phone('parent_home_phone', 'Parent home phone', { required: false,
      help: 'Optional — your cell number below is fine if home is the same.' }),
    phone('parent_cell_phone', 'Parent cell phone', { required: true }),
    txt('student_name', 'Student name', { required: true }),
    dateF('pickup_start_date', 'Pickup start date', { required: true }),
    dateF('pickup_end_date', 'Pickup end date', { required: true }),

    blockSection('Authorized pick-up person',
      'Identification MUST be provided upon pick-up.'),
    txt('authorized_name', 'Name of authorized person', { required: true }),
    area('authorized_address', 'Address', { required: true }),
    phone('authorized_home_phone', 'Home phone', { required: false }),
    phone('authorized_cell_phone', 'Cell phone', { required: true }),

    ...eSignatureBlock({
      acknowledgment: 'I understand that once my child has been released to the above authorized individual, Desert Garden Montessori is no longer responsible. ' + DGM_ESIG_CONSENT,
      requireEmail: false, // captured above
    }),
  ];
  return {
    slug: 'pickup-authorization',
    display_name: src.title,
    description: src.description,
    category: 'permission',
    per_student: true,
    is_active: true, needs_review: false,
    allow_addendum: false, resubmission_allowed: true, one_submission_per_year: false,
    field_schema,
    confirmation_message: 'Thanks! The authorization is on file. The named individual must show ID to pick up your child.',
    confirmation_redirect_url: null,
    notify_emails: [], webhook_urls: [],
    fee_amount: null, payment_config: null,
  };
}

function buildLeCampout(src) {
  const field_schema = [
    blockHeader(src.title),
    blockParagraph(src.description),
    blockParagraph(
      'NOTE: Trip dates need to be updated each year — currently set to April 8th–10th. ' +
      'Edit this form before sending the next cohort to refresh the dates.',
      'warning',
    ),

    radioF('travel_permission',
      'My student has permission to travel with DGM adult chaperones to Tonto Rim Christian Camp from April 8th–10th and participate in campout related activities and excursions.',
      ['Yes', 'No'], { required: true }),
    txt('student_first_name', "Student's first name", { required: true }),
    txt('student_last_name', "Student's last name", { required: true }),
    radioF('gender', 'Gender', ['Female', 'Male'], { required: false }),
    dateF('date_of_birth', 'Date of birth', { required: true }),

    ...eSignatureBlock({ requireEmail: false }),
  ];
  return {
    slug: 'le-campout-excursion',
    display_name: src.title,
    description: src.description,
    category: 'trip',
    per_student: true,
    is_active: true, needs_review: false,
    allow_addendum: false, resubmission_allowed: true, one_submission_per_year: true,
    field_schema,
    confirmation_message: DEFAULT_CONFIRMATIONS.trip,
    confirmation_redirect_url: null,
    notify_emails: [], webhook_urls: [],
    fee_amount: null, payment_config: null,
  };
}

function buildMyhsOtcConsent(src) {
  // Brief §6: split the free-text allergy question into a Yes/No radio
  // with a conditional follow-up.
  // Brief §5.4: implement the source's checkbox_grid as a single
  // "check all you authorize" multi-select with the medication list.
  const meds = [
    'Acetaminophen (Tylenol)',
    'Ibuprofen (Advil)',
    'Sunscreen',
    'Anti Nausea Medications',          // typo fix applied
    'Pepto Bismol',
    'Antibiotic Cream (Neosporin)',
    'Hydrocortisone Cream (Cortaid)',   // typo fix applied
    'Burn Gels',
    'Antihistamine (Benadryl, Zyrtec)',
    'Cough Drops',
  ];

  const field_schema = [
    blockHeader(src.title),
    blockParagraph(src.description),
    blockParagraph(
      'Policy: Non-prescription OTC medications are dispensed as needed upon completion of this form, per package directions and weight/age-appropriate dosing. ' +
      'If medication is needed for 3 consecutive days, a licensed healthcare-provider order is required to continue. ' +
      'To minimize overdose risk, non-prescribed medication is not dispensed during the first or last hour of the school day.',
      'note',
    ),

    txt('student_first_name', "Student's first name", { required: true }),
    txt('student_last_name', "Student's last name", { required: true }),

    multi('authorized_medications',
      'Check each medication you authorize the school nurse / front desk to administer as needed.',
      meds,
      { required: true, help: 'Unchecked medications WILL NOT be administered.' },
    ),

    blockSection('Medication history'),
    // §6: convert from free-text to Yes/No + conditional
    radioF('any_allergies', 'Is your student allergic to any medication?',
      ['Yes', 'No'], { required: true }),
    area('allergy_details',
      'If Yes, list the medicine(s) and the type of reaction',
      { required: false, help: 'Only complete if you answered Yes above.' }),

    radioF('takes_regular_meds',
      'Does your student take any medication (OTC or prescription) on a regular basis?',
      ['Yes', 'No'], { required: true }),
    area('regular_med_details',
      'If Yes, please list',
      { required: false, help: 'Only complete if you answered Yes above.' }),

    ...eSignatureBlock({
      acknowledgment:
        'I understand that by signing this form I am allowing Desert Garden Montessori to administer the medications indicated above ' +
        'in accordance with the manufacturer\'s recommended dosage. I will be informed of any medication given to my child as soon as possible. ' +
        DGM_ESIG_CONSENT,
      requireEmail: true,
    }),
  ];
  return {
    slug: 'myhs-otc-medication-consent',
    display_name: src.title,
    description: src.description,
    category: 'medical',
    per_student: true,
    is_active: true, needs_review: false,
    allow_addendum: true, resubmission_allowed: true, one_submission_per_year: true,
    field_schema,
    confirmation_message: DEFAULT_CONFIRMATIONS.medical,
    confirmation_redirect_url: null,
    notify_emails: [], webhook_urls: [],
    fee_amount: null, payment_config: null,
  };
}

function buildCafeWorker(src) {
  const field_schema = [
    blockHeader(src.title),
    blockParagraph(src.description),
    blockParagraph(
      'NOTE: brand assets sometimes call this "The Wellness Cafe" — confirm with marketing whether to rename here.',
      'note',
    ),
    txt('student_name', 'Student name', { required: true }),
    ...eSignatureBlock({ requireEmail: false }),
  ];
  return {
    slug: 'cafe-worker-permission',
    display_name: src.title,
    description: src.description,
    category: 'permission',
    per_student: true,
    is_active: true, needs_review: false,
    allow_addendum: false, resubmission_allowed: true, one_submission_per_year: true,
    field_schema,
    confirmation_message: DEFAULT_CONFIRMATIONS.permission,
    confirmation_redirect_url: null,
    notify_emails: [], webhook_urls: [],
    fee_amount: null, payment_config: null,
  };
}

function buildChildplayFieldtrip(src) {
  const field_schema = [
    blockHeader(src.title),
    blockParagraph(
      'Who: Lower Elementary\n' +
      'Venue: Herberger Theatre, 22 E Monroe St, Phoenix, AZ 85004\n' +
      'Date: Friday, May 1\n' +
      'Time: 8:30am – 2:00pm',
      'note',
    ),
    blockParagraph(src.description),

    txt('child_name', "Child's name", { required: true }),
    selectF('child_classroom', "Child's classroom",
      ['CR11 (Ms. Denise & Ms. Rose)', 'CR12 (Ms. Jill)'], { required: true }),
    radioF('attend_permission',
      'Does your child have your permission to attend this field trip?',
      ['Yes', 'No'], { required: true }),
    radioF('transport_permission',
      'Does your child have your permission to ride in the DGM-provided transportation?',
      ['Yes', 'No'], { required: true }),

    ...eSignatureBlock(),
  ];
  return {
    slug: 'fieldtrip-childplay-theater',
    display_name: src.title,
    description: src.description,
    category: 'trip',
    per_student: true,
    is_active: true, needs_review: false,
    allow_addendum: false, resubmission_allowed: false, one_submission_per_year: false,
    field_schema,
    confirmation_message: DEFAULT_CONFIRMATIONS.trip,
    confirmation_redirect_url: null,
    notify_emails: [], webhook_urls: [],
    fee_amount: null, payment_config: null,
  };
}

function buildStayingSafe(src, level) {
  // Brief §5.3: drop the teacher-email dropdown (classroom is enough).
  const classrooms = level === 'le'
    ? ['LE CR11', 'LE CR12']
    : ['Primary CR1', 'Primary CR2', 'Primary CR7', 'Primary CR8'];

  const field_schema = [
    blockHeader(src.title),
    blockParagraph(
      'Who: ' + (level === 'le' ? 'Lower Elementary students' : 'Primary students (ages 4–6)') + '\n' +
      'Venue: in respective classrooms\n' +
      'Date: Week of September 16\n' +
      'Time: morning',
      'note',
    ),
    blockParagraph(src.description),

    txt('student_first_name', "Student's first name", { required: true }),
    txt('student_last_name', "Student's last name", { required: true }),
    radioF('classroom', 'Classroom', classrooms, { required: true,
      help: 'Your classroom selection tells us who your child\'s teacher is.' }),
    radioF('attend_permission',
      'Does your child have your permission to attend this presentation?',
      ['Yes', 'No'], { required: true }),

    ...eSignatureBlock(),
  ];
  return {
    slug: level === 'le' ? 'le-staying-safe-permission' : 'primary-staying-safe-permission',
    display_name: src.title,
    description: src.description,
    category: 'permission',
    per_student: true,
    is_active: true, needs_review: false,
    allow_addendum: false, resubmission_allowed: false, one_submission_per_year: true,
    field_schema,
    confirmation_message: DEFAULT_CONFIRMATIONS.permission,
    confirmation_redirect_url: null,
    notify_emails: [], webhook_urls: [],
    fee_amount: null, payment_config: null,
  };
}

function buildMosquitoRepellent(src) {
  const field_schema = [
    blockHeader(src.title),
    blockParagraph(src.description),

    txt('student_name', 'Student name', { required: true }),
    radioF('classroom', 'Classroom', ALL_CLASSROOMS, { required: true,
      help: 'Source form only listed Primary classrooms; this version covers all of DGM. Adjust if you want to restrict.' }),

    blockSection('Parent / guardian consent'),
    radioF('consent_choice', 'I authorize staff to apply the non-toxic, allergen-free mosquito spray to my child as needed during outdoor activities.',
      [
        'I GIVE PERMISSION for staff to apply the spray to my child as needed.',
        'I DO NOT GIVE PERMISSION for staff to apply mosquito spray to my child. I understand my child may be more exposed to mosquito bites while outdoors.',
      ],
      { required: true }),

    ...eSignatureBlock({ requireEmail: true }),
    phone('parent_phone', 'Parent phone', { required: true }),
  ];
  return {
    slug: 'mosquito-repellent-permission',
    display_name: src.title,
    description: src.description,
    category: 'permission',
    per_student: true,
    is_active: true, needs_review: false,
    allow_addendum: false, resubmission_allowed: true, one_submission_per_year: true,
    field_schema,
    confirmation_message: DEFAULT_CONFIRMATIONS.permission,
    confirmation_redirect_url: null,
    notify_emails: [], webhook_urls: [],
    fee_amount: null, payment_config: null,
  };
}

function buildRequestMedication(src) {
  const field_schema = [
    blockHeader(src.title),
    blockParagraph(src.description),

    txt('child_name', "Child's name", { required: true }),
    selectF('child_classroom', "Child's classroom", ALL_CLASSROOMS, { required: true }),
    txt('medication_name', 'Name of medication', { required: true }),
    radioF('medication_type', 'Type of medication',
      ['Over the counter', 'Prescription medication'], { required: true }),
    txt('rx_number', 'Prescription RX#', {
      required: false,
      help: 'Required if prescription; leave blank or put N/A for OTC.',
    }),
    txt('dosage', 'Dosage', { required: true,
      help: 'Specify the amount of medication to be given.' }),
    txt('route', 'Route (method of administration)', { required: false }),
    area('side_effects', 'List all/any possible side effects', { required: false }),
    dateF('start_date', 'Administration start date', { required: true }),
    dateF('end_date', 'Administration end date', { required: true }),
    selectF('time_frequency', 'Time and frequency',
      ['As needed', '1x daily', '2x daily', '3x daily', 'Morning', 'Afternoon', 'Evening', 'Every 4–6 hours', 'Other — please specify below'],
      { required: true }),
    area('time_frequency_other', 'If you selected "Other" above, explain the time and frequency needed.',
      { required: false, help: 'Only complete if you selected "Other" above.' }),
    txt('reason_for_medication', 'Reason for medication', { required: true }),

    blockSection('Parent information and signature',
      'I have read and understand that these procedures are intended to help assure the safety of my child as well as other students attending Desert Garden Montessori. I understand that I will be required to physically complete and sign a medication form by the Arizona Department of Health Services at the front desk.'),
    ...eSignatureBlock({
      acknowledgment:
        'I give permission for the administration of the medication, according to the instructions listed, to the child listed above. ' +
        DGM_ESIG_CONSENT,
      requireEmail: true,
    }),
  ];
  return {
    slug: 'request-administering-medication',
    display_name: src.title,
    description: src.description,
    category: 'medical',
    per_student: true,
    is_active: true, needs_review: false,
    allow_addendum: false, resubmission_allowed: true, one_submission_per_year: false,
    field_schema,
    confirmation_message: DEFAULT_CONFIRMATIONS.medical,
    confirmation_redirect_url: null,
    notify_emails: [], webhook_urls: [],
    fee_amount: null, payment_config: null,
  };
}

// ── SPORT REGISTRATION TEMPLATE ──────────────────────────────────────
// Brief §4.1 — Flag Football / Golf / Pickleball share core structure.
// Spartan is its own thing (tiered pricing + dual parent contacts).

function buildSportRegistration(src, sportKey) {
  const config = SPORT_CONFIG[sportKey];
  // §6 fix: Golf classroom "High" → "High School"
  const classrooms = config.classrooms.map((c) => c === 'High' ? 'High School' : c);

  const field_schema = [
    blockHeader(src.title),
    blockParagraph(src.description),

    txt('student_name', 'Student name', { required: true }),
    selectF('student_classroom', 'Student classroom', classrooms, { required: true }),
    ...(config.seasons.length > 0
      ? [radioF('season', 'What season are you registering for?', config.seasons, { required: true,
          help: 'These season names need to be updated each year.' })]
      : []),
    radioF('shirt_size', 'Shirt size', config.shirtSizes, { required: true }),

    blockSection('FACTS billing authorization',
      `By submitting this form you authorize the DGM Finance Team to charge your FACTS account ${config.feeText}. ` +
      'All associated fees are non-refundable.'),
    checkboxF('facts_authorization',
      `I authorize DGM to charge my FACTS account ${config.feeText} for ${config.sportName} registration.`,
      { required: true }),

    ...eSignatureBlock({ requireEmail: true }),
  ];
  return {
    slug: `${sportKey}-registration`,
    display_name: src.title,
    description: src.description,
    category: 'registration',
    per_student: true,
    is_active: true, needs_review: false,
    allow_addendum: false, resubmission_allowed: false, one_submission_per_year: false,
    field_schema,
    confirmation_message: DEFAULT_CONFIRMATIONS.registration,
    confirmation_redirect_url: null,
    notify_emails: [], webhook_urls: [],
    fee_amount: config.feeAmount,
    payment_config: null, // FACTS billing — no Stripe Checkout
  };
}

const SPORT_CONFIG = {
  'flag-football': {
    sportName: 'Flag Football',
    classrooms: ['Upper Elementary CR10', 'Upper Elementary Tower', 'Middle School'],
    seasons: ['Fall 2025', 'Spring 2026'],
    shirtSizes: ['XS', 'S', 'M', 'L', 'XL', 'XXL'],
    feeAmount: 250,
    feeText: '$250',
  },
  'golf': {
    sportName: 'Golf',
    classrooms: ['Upper Elementary CR10', 'Upper Elementary Tower', 'Middle School', 'High School'],
    seasons: [],
    shirtSizes: ['XS', 'S', 'M', 'L', 'XL', 'XXL'],
    feeAmount: 220,
    feeText: '$220',
  },
  'pickleball': {
    sportName: 'Pickleball',
    classrooms: ['LE CR11', 'LE CR12', 'UE CR10', 'UE Tower', 'MS 7 & 8', 'HS 9, 10, 11 & 12'],
    seasons: [],
    shirtSizes: ['Youth S', 'Youth M', 'Youth L', 'Youth XL', 'Adult S', 'Adult M', 'Adult L', 'Adult XL'],
    feeAmount: 220,
    feeText: '$220',
  },
};

function buildSpartanRegistration(src) {
  const field_schema = [
    blockHeader(src.title),
    blockParagraph(src.description),

    selectF('training_option', 'Training option / pricing tier',
      [
        '$220 — Spartan Kids (Primary, must be 5+)',
        '$220 — LE Spartan Kids',
        '$220 — UE and MYHS Spartan Kids',
        '$250 — Alumni or non-DGM sibling',
      ],
      { required: true }),

    blockSection('Parent contact (primary)'),
    email('parent1_email', 'Parent #1 email', { required: true }),
    phone('parent1_phone', 'Parent #1 phone', { required: true }),

    blockSection('Parent contact (secondary, optional)'),
    email('parent2_email', 'Parent #2 email', { required: false }),
    phone('parent2_phone', 'Parent #2 phone', { required: false }),

    blockSection('Student'),
    txt('student_name', 'Student name', { required: true }),
    dateF('student_birthdate', 'Student birthdate', { required: true }),
    selectF('student_classroom', 'Student classroom',
      ['Primary CR1', 'Primary CR2', 'Primary CR7', 'Primary CR8',
       'LE CR11', 'LE CR12', 'UE Tower', 'UE CR10', 'MYHS', 'Other'],
      { required: true }),
    phone('student_phone', 'Student phone (if applicable)', { required: false }),
    email('student_email', 'Student email (if applicable)', { required: false }),
    selectF('shirt_size', 'Shirt size',
      ['Adult XS','Adult S','Adult M','Adult L','Adult XL','Youth XS','Youth S','Youth M','Youth L','Youth XL'],
      { required: true }),
    selectF('pant_short_size', 'Pant / short size',
      ['Adult XS','Adult S','Adult M','Adult L','Adult XL','Youth XS','Youth S','Youth M','Youth L','Youth XL'],
      { required: true }),

    blockSection('FACTS billing authorization'),
    checkboxF('facts_authorization',
      'I authorize DGM to charge my FACTS account (or pay by cash / check at the front desk if I am an alumni without FACTS) for the training option I selected above.',
      { required: true }),

    // Brief §6 flag: source had no parent signature despite payment auth. Adding.
    ...eSignatureBlock({ requireEmail: false /* captured above */ }),
  ];
  return {
    slug: 'spartan-registration',
    display_name: src.title,
    description: src.description,
    category: 'registration',
    per_student: true,
    is_active: true, needs_review: false,
    allow_addendum: false, resubmission_allowed: false, one_submission_per_year: false,
    field_schema,
    confirmation_message: DEFAULT_CONFIRMATIONS.registration,
    confirmation_redirect_url: null,
    notify_emails: [], webhook_urls: [],
    fee_amount: 220, // base tier — actual will vary by selection
    payment_config: null,
  };
}

function buildRecordsRelease(src) {
  // §6: source form does not mark any fields required.
  // Apply: name, address, signature, date all required.
  const field_schema = [
    blockHeader(src.title),

    blockSection('Student information'),
    txt('student_full_name', "Student's full name", { required: true }),
    dateF('date_of_birth', 'Date of birth', { required: true }),
    txt('grade_entering', 'Grade entering', { required: true }),
    area('student_address', 'Address (street, city, state, zip)', { required: true }),
    phone('student_phone', 'Phone', { required: false }),
    email('student_email', 'Email', { required: false }),

    blockSection('Current / previous school information'),
    txt('prior_school_name', 'Name of school, service provider, or evaluator', { required: true }),
    area('prior_school_address', 'Address', { required: false }),
    email('prior_registrar_email', 'Registrar email', { required: true,
      help: 'Karen Hurlbert will email the records request to this address.' }),
    phone('prior_school_phone', 'Phone', { required: false }),
    phone('prior_school_fax', 'Fax', { required: false }),

    multi('records_requested',
      'Please check all the information requested:',
      [
        'Complete education file',
        'Special education files (if applicable)',
        'Permission to make / receive phone calls from the above listed professional',
        'Other (specify below)',
      ],
      { required: true }),
    area('records_other_details',
      'If you checked "Other" above, please specify additional information:',
      { required: false, help: 'Only complete if you checked "Other" above.' }),

    ...eSignatureBlock({
      acknowledgment:
        'In order to assist in the provision of an appropriate education program for my child, and in accordance with the Family Educational Rights and Privacy Act of 1974 and Arizona State Law, I hereby authorize the release to Desert Garden Montessori of any student records — including grades, health records, and psychological, social, educational, and developmental records — for the above student. ' +
        DGM_ESIG_CONSENT,
      requireEmail: true,
    }),

    blockParagraph(
      'Records to: Desert Garden Montessori, 5130 E. Warner Road, Phoenix, AZ 85044. ' +
      'Phone 480-496-9833 · Fax 480-705-8579 · Attention: Karen Hurlbert (karen@desertgardenmontessori.org).',
      'note',
    ),
  ];
  return {
    slug: 'records-release-authorization',
    display_name: src.title,
    description: src.description,
    category: 'release',
    per_student: true,
    is_active: true, needs_review: false,
    allow_addendum: false, resubmission_allowed: true, one_submission_per_year: false,
    field_schema,
    confirmation_message: DEFAULT_CONFIRMATIONS.release,
    confirmation_redirect_url: null,
    notify_emails: [], webhook_urls: [],
    fee_amount: null, payment_config: null,
  };
}

function buildStateEmergencyCard(src) {
  // Brief §5.6: render only the PARENT-FACING portion. Strip staff
  // tracking fields and CDC/SGH# header.
  const field_schema = [
    blockHeader(src.title),
    blockParagraph(src.description, 'note'),

    blockSection('Child information'),
    txt('child_name', "Child's name", { required: true }),
    area('child_home_address', 'Home address (street, city, state, zip)', { required: true }),
    phone('child_home_phone', 'Home phone', { required: true }),
    dateF('child_dob', 'Date of birth', { required: true }),
    radioF('child_sex', 'Sex', ['Male', 'Female'], { required: true }),

    blockSection('Parent / Guardian #1'),
    txt('pg1_name', 'Parent / guardian name', { required: true }),
    area('pg1_address', 'Home address (street, city, state, zip)', { required: true }),
    phone('pg1_cell_phone', 'Cell phone (optional)', { required: false }),
    phone('pg1_contact_phone', 'Contact telephone number', { required: true }),

    blockSection('Parent / Guardian #2 (if applicable)'),
    txt('pg2_name', 'Parent / guardian name', { required: false }),
    area('pg2_address', 'Home address (street, city, state, zip)', { required: false }),
    phone('pg2_cell_phone', 'Cell phone (optional)', { required: false }),
    phone('pg2_contact_phone', 'Contact telephone number', { required: false }),

    blockSection('Authorized emergency pick-up contacts',
      'I authorize the following individuals to collect my child from the facility in case of emergency or if I cannot be contacted. ' +
      'Pursuant to R9-5-304.B, at least two contacts are required.'),
    txt('contact1_name', 'Contact 1 — name', { required: true }),
    phone('contact1_phone', 'Contact 1 — telephone number', { required: true }),
    txt('contact2_name', 'Contact 2 — name', { required: true }),
    phone('contact2_phone', 'Contact 2 — telephone number', { required: true }),
    txt('contact3_name', 'Contact 3 — name (optional)', { required: false }),
    phone('contact3_phone', 'Contact 3 — telephone number (optional)', { required: false }),
    txt('contact4_name', 'Contact 4 — name (optional)', { required: false }),
    phone('contact4_phone', 'Contact 4 — telephone number (optional)', { required: false }),

    blockSection('Medical care',
      'If medical care is necessary, call:'),
    txt('provider_name', 'Health care provider name', { required: true,
      help: 'A health care provider is a physician, physician assistant, or registered nurse practitioner.' }),
    phone('provider_phone', 'Health care provider contact phone', { required: true }),
    txt('emergency_first_call',
      'In case of injury or sudden illness, request that this individual be called first:',
      { required: false }),

    blockSection('Restricted pick-up / custody'),
    area('restricted_individuals',
      'The following individual(s) may NOT remove my child from the facility',
      { required: false }),
    radioF('custody_papers_on_file',
      'Custody papers have been provided and are on file at the facility',
      ['Yes', 'No'], { required: false }),
    txt('telephone_auth_code', 'Telephone authorization code (optional)', { required: false }),

    blockSection('Emergency medical authorization',
      'I hereby give authority to any hospital or doctor to render immediate aid as might be required at the time for his/her health and safety.'),

    blockSection('Immunization information',
      'Please attach a current immunization record OR an exemption affidavit. For current requirements see www.azdhs.gov/phs/immun/index.htm or call the Arizona Immunization Program Office at (602) 364-3630.'),
    radioF('immunization_doc_type',
      'Immunization documentation type (one must be attached)',
      [
        'Copy of current official documented immunization record attached',
        'Religious Beliefs exemption form signed by parent / guardian attached',
        'Medical Exemption form signed by physician and parent / guardian attached',
        'Signed Laboratory Proof of Immunity form attached',
      ], { required: true }),
    fileF('immunization_file', 'Immunization documentation file upload', {
      required: true,
      help: 'Required per ADHS Bureau of Child Care Licensing — must accompany this card.',
    }),

    blockSection('Medical information'),
    radioF('child_food_allergies', 'Is your child allergic to food or other substances?', ['No', 'Yes'], { required: true }),
    area('child_food_allergies_details',
      'If Yes, describe symptoms, name foods or substances to be avoided, and the procedure to follow if a reaction occurs',
      { required: false, help: 'Only complete if you answered Yes above.' }),
    radioF('child_infection_susceptibility', 'Is your child usually susceptible to infections?', ['No', 'Yes'], { required: true }),
    area('child_infection_precautions', 'If Yes, list precautions to be taken',
      { required: false, help: 'Only complete if you answered Yes above.' }),
    radioF('child_convulsions', 'Is your child subject to convulsions?', ['No', 'Yes'], { required: true }),
    area('child_convulsions_procedure', 'If Yes, specify the procedure to follow if one occurs',
      { required: false, help: 'Only complete if you answered Yes above.' }),
    radioF('child_other_physical_condition',
      'Is there any physical condition we should be aware of (heart trouble, foot problem, hearing impairment, hernia, etc.)?',
      ['No', 'Yes'], { required: true }),
    area('child_other_physical_precautions', 'If Yes, list precautions',
      { required: false, help: 'Only complete if you answered Yes above.' }),
    area('child_additional_comments', 'Additional comments', { required: false }),
    area('child_special_instructions', 'Other special instructions', { required: false }),

    blockSection('Certification',
      'This Emergency Information and Immunization Record Card is accurate and complete, front and back.'),
    txt('pg_printed_name', 'Parent / guardian PRINTED name', { required: true }),
    ...eSignatureBlock({ requireEmail: false }),
  ];
  return {
    slug: 'az-state-emergency-immunization-card',
    display_name: 'Arizona Emergency, Information & Immunization Record Card',
    description: src.description,
    category: 'medical',
    per_student: true,
    is_active: true, needs_review: false,
    allow_addendum: true, resubmission_allowed: true, one_submission_per_year: true,
    field_schema,
    confirmation_message: 'Thanks! Your child\'s emergency, information, and immunization record is on file with the front desk. We\'ll reach out if anything additional is needed.',
    confirmation_redirect_url: null,
    notify_emails: [], webhook_urls: [],
    fee_amount: null, payment_config: null,
  };
}

function buildStateMedicationConsent(src) {
  // Brief §5.6: render ONLY the parent-facing portion. Staff
  // pre-administration checklist + administration log are operational.
  const field_schema = [
    blockHeader(src.title),
    blockParagraph(src.description, 'note'),

    blockSection('Child & medication information'),
    txt('child_name', 'First & last name of CHILD', { required: true }),
    txt('medication_name', 'Type / name of medication', { required: true }),
    txt('rx_number', 'Prescription #', { required: false,
      help: 'Required for prescription medications.' }),
    txt('dosage', 'Dosage', { required: true }),
    txt('route', 'Route (method of administration)', { required: true,
      help: 'For injections, attach your health-care provider\'s written authorization below.' }),
    fileF('hcp_injection_authorization',
      'Health-care provider written authorization (only required if route involves injection)',
      { required: false }),
    dateF('start_date', 'Start date', { required: true }),
    dateF('end_date', 'End date', { required: true }),
    txt('time_frequency', 'Times & frequency', { required: true }),
    area('reason', 'Reason for medication', { required: true }),
    area('side_effects', 'Possible side effects to watch for with this medication', { required: false }),

    ...eSignatureBlock({
      acknowledgment:
        'I give permission for the administration of the medication, according to the instructions listed, to the child listed above. ' +
        DGM_ESIG_CONSENT,
      requireEmail: false,
    }),
  ];
  return {
    slug: 'az-state-medication-consent',
    display_name: 'Arizona State Medication Consent (CCL 302)',
    description: src.description,
    category: 'medical',
    per_student: true,
    is_active: true, needs_review: false,
    allow_addendum: false, resubmission_allowed: true, one_submission_per_year: false,
    field_schema,
    confirmation_message: DEFAULT_CONFIRMATIONS.medical,
    confirmation_redirect_url: null,
    notify_emails: [], webhook_urls: [],
    fee_amount: null, payment_config: null,
  };
}

// ── SUMMER REGISTRATION ──────────────────────────────────────────────
// JSON missing options for lunch / restrictions / daily schedule. Seed
// with plausible defaults and a needs_review flag is_active=true but
// notify staff via a paragraph block to confirm.

function buildSummerItp(src) {
  const weeks = [
    'Week 1: June 1 – June 5',
    'Week 2: June 8 – June 12',
    'Week 3: June 15 – June 19',
    'Week 4: June 22 – June 26',
    'Week 5: June 29 – July 2',
    'Week 6: July 6 – July 10',
    'Week 7: July 13 – July 17',
    'Week 8: July 20 – July 24',
  ];
  const field_schema = [
    blockHeader(src.title),
    blockParagraph(src.description),
    blockParagraph(
      'NOTE for school staff: confirm the dropdown options for Lunch Selection, Lunch Restrictions, and Daily Schedule. ' +
      'These were not in the source PDF — sensible defaults are seeded below.',
      'warning',
    ),

    blockSection('Monthly option',
      'Monthly rates: Infant — School Day $1,900 / Extended Day $2,382. ' +
      'Toddler & Primary — Half Day $1,270 / School Day $1,583 / Extended Day $2,065.'),
    radioF('enroll_june', 'Enroll for June (Session 1, June 1 – June 30)?', ['Yes', 'No'], { required: true }),
    radioF('enroll_july', 'Enroll for July (Session 2, July 1 – July 31)?', ['Yes', 'No'], { required: true }),

    blockSection('Weekly option (Primary only)',
      'Weekly rates for Primary ONLY: Half Day $350 / School Day $435 / Extended Day $565, prorated for Juneteenth and July 4th holiday.'),
    multi('weekly_attendance', 'Select weeks of attendance', weeks, { required: false }),

    blockSection('Daily schedule',
      'Summer half day is available only to Toddler and Primary programs.'),
    radioF('daily_schedule', 'Daily schedule', ['Half Day', 'School Day', 'Extended Day'], { required: true,
      help: 'CONFIRM with DGM if other options exist.' }),

    blockSection('Summer lunch',
      'Lunch is included in the summer tuition price.'),
    selectF('lunch_selection', 'Lunch selection',
      ['Regular organic lunch', 'Vegetarian', 'Gluten-free', 'Dairy-free', 'Other (specify in allergies)'],
      { required: true, help: 'CONFIRM exact options with DGM.' }),
    multi('lunch_restrictions', 'Lunch restrictions',
      ['Vegetarian', 'Vegan', 'Gluten-free', 'Dairy-free', 'Nut-free', 'No pork', 'Other'],
      { required: false, help: 'CONFIRM exact options with DGM.' }),
    area('allergies', 'Allergies', { required: true,
      help: 'List ALL food allergies / sensitivities. Write "none" if none.' }),

    blockSection('Summer billing'),
    checkboxF('billing_acknowledgment',
      'Summer tuition will be billed through FACTS based on the selections above. Summer tuition is NON-REFUNDABLE and DUE IN FULL on May 1. NO REFUNDS WILL BE ISSUED FOR ABSENCES OR WITHDRAWALS AFTER MAY 1.',
      { required: true }),

    ...eSignatureBlock({ requireEmail: true }),
  ];
  return {
    slug: 'summer-registration-itp-2026',
    display_name: src.title,
    description: src.description,
    category: 'registration',
    per_student: true,
    is_active: true, needs_review: false,
    allow_addendum: false, resubmission_allowed: true, one_submission_per_year: true,
    field_schema,
    confirmation_message: DEFAULT_CONFIRMATIONS.registration,
    confirmation_redirect_url: null,
    notify_emails: [], webhook_urls: [],
    fee_amount: null, payment_config: null,
  };
}

function buildSummerElementary(src) {
  const weeks = [
    'Week 1: June 1 – June 5',
    'Week 2: June 8 – June 12',
    'Week 3: June 15 – June 19',
    'Week 4: June 22 – June 26',
    'Week 5: June 29 – July 2',
    'Week 6: July 6 – July 10',
    'Week 7: July 13 – July 17',
    'Week 8: July 20 – July 24',
  ];
  const field_schema = [
    blockHeader(src.title),
    blockParagraph(src.description),
    blockParagraph(
      'NOTE for school staff: confirm the dropdown options for Daily Schedule, Lunch Selection, and Lunch Restrictions. ' +
      'These were not in the source PDF — sensible defaults are seeded below.',
      'warning',
    ),

    blockSection('Summer session selection',
      'Weekly rate $400 per week — INCLUDES ORGANIC LUNCH, prorated for the Juneteenth and July 4th holidays.'),
    multi('weekly_attendance', 'Select weeks of attendance', weeks, { required: true }),

    blockSection('Daily schedule',
      'Extended Day pricing is available at request.'),
    radioF('daily_schedule', 'Daily schedule', ['School Day', 'Extended Day'], { required: true,
      help: 'CONFIRM with DGM if other options exist.' }),

    blockSection('Summer organic lunch — Elementary lunch selection',
      'Organic Lunch is included in the weekly summer rate.'),
    selectF('lunch_selection', 'Lunch selection',
      ['Regular organic lunch', 'Vegetarian', 'Gluten-free', 'Dairy-free', 'Other (specify in allergies)'],
      { required: true, help: 'CONFIRM exact options with DGM.' }),
    multi('lunch_restrictions', 'Lunch restrictions',
      ['Vegetarian', 'Vegan', 'Gluten-free', 'Dairy-free', 'Nut-free', 'No pork', 'Other'],
      { required: false, help: 'CONFIRM exact options with DGM.' }),
    area('allergies', 'Allergies', { required: false,
      help: 'List ALL food allergies / sensitivities, or write "none".' }),

    blockSection('Summer billing'),
    checkboxF('billing_acknowledgment',
      'Summer tuition will be billed through FACTS based on the selections above. Summer tuition is NON-REFUNDABLE and DUE IN FULL on May 1st. NO REFUNDS WILL BE ISSUED FOR ABSENCES OR WITHDRAWALS AFTER MAY 1st.',
      { required: true }),

    ...eSignatureBlock({ requireEmail: true }),
  ];
  return {
    slug: 'summer-registration-elementary-2026',
    display_name: src.title,
    description: src.description,
    category: 'registration',
    per_student: true,
    is_active: true, needs_review: false,
    allow_addendum: false, resubmission_allowed: true, one_submission_per_year: true,
    field_schema,
    confirmation_message: DEFAULT_CONFIRMATIONS.registration,
    confirmation_redirect_url: null,
    notify_emails: [], webhook_urls: [],
    fee_amount: null, payment_config: null,
  };
}

// ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { schoolId: null, refresh: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--school-id') out.schoolId = argv[++i];
    else if (a === '--refresh') out.refresh = true;
  }
  return out;
}
