// Seed Media Children's House parent-portal forms.
//
// Source: PDFs in mch-forms/ (sibling repo root). Text was extracted
// via pdftotext + the CD-51 health form was read directly from the
// scanned PDF; field_schemas below mirror each source form verbatim.
//
// Forms seeded (10):
//   1. mch-emergency-contact-consent     (PA 55 Code 3270.124)
//   2. mch-act-90-textbook-request       (Act 90 / 195 textbook loan)
//   3. mch-dhs-agreement                 (school-year Extended Care)
//   4. mch-dhs-agreement-summer-camp     (Summer Camp DHS contract)
//   5. mch-child-health-report           (CD-51, hybrid w/ file upload)
//   6. mch-dental-exam                   (Hybrid w/ file upload)
//   7. mch-medication-log                (Medication authorization)
//   8. mch-parent-handbook-acknowledgment
//   9. mch-press-release                 (Photo / media consent)
//  10. mch-potty-training-acknowledgment
//
// Three source PDFs were intentionally NOT seeded because they're not
// fillable forms — they're cover emails describing what's in the portal:
//   - MCH SUMMER CAMP_ CURRENT STUDENTS School Documents... (welcome)
//   - MCH SUMMER CAMP_ NEW STUDENT School Documents...     (welcome)
//   - Updated child health report (chase email — the actual form is
//                                  the CD-51, seeded above)
//
// Usage:
//   node scripts/seed-mch-parent-forms.mjs               # default
//   node scripts/seed-mch-parent-forms.mjs --refresh     # force-update
//
// Idempotent — upserts on (school_id, slug). Pass --refresh to
// overwrite forms that have already been hand-curated (needs_review=false).

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

const args = parseArgs(process.argv.slice(2));
const MCH_SCHOOL_ID = 'a6c4b2dd-050c-4bf9-893b-67106f0f20e8';

// MCH's published admin address (printed on the Dental form). Office
// staff TBD — MCH can add more recipients via the form editor's
// "Notify these office emails" field; this seed just provides a
// sensible default so the first submission has someone to land at.
const MCH_NOTIFY_EMAIL = 'mchadmin@mediachildrenshouse.com';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── Block helpers (match DGM seeders for consistency) ───────────────
const blockHeader = (text) => ({ type: 'header', text });
const blockSection = (label, description = null) =>
  description ? { type: 'section', label, description } : { type: 'section', label };
const blockParagraph = (text, emphasis) =>
  emphasis ? { type: 'paragraph', text, emphasis } : { type: 'paragraph', text };
const txt = (key, label, opts = {}) => ({ type: 'text', key, label, ...opts });
const area = (key, label, opts = {}) => ({ type: 'textarea', key, label, rows: 3, ...opts });
const tel = (key, label, opts = {}) => ({ type: 'tel', key, label, ...opts });
const dateF = (key, label, opts = {}) => ({ type: 'date', key, label, ...opts });
const timeF = (key, label, opts = {}) => ({ type: 'time', key, label, ...opts });
const numF = (key, label, opts = {}) => ({ type: 'number', key, label, ...opts });
const fileF = (key, label, opts = {}) => ({ type: 'file_upload', key, label, max_size_mb: 10, ...opts });
const radioF = (key, label, options, opts = {}) => ({
  type: 'radio', key, label,
  options: options.map((v) => typeof v === 'string' ? { value: keyify(v), label: v } : v),
  ...opts,
});
const checkboxF = (key, label, opts = {}) => ({ type: 'checkbox', key, label, ...opts });
// Multi-select checkbox list. `options` is the same shape as radioF —
// either string[] (auto-keyified) or {value,label}[].
const multiCheckboxF = (key, label, options, opts = {}) => ({
  type: 'multi_checkbox', key, label,
  options: options.map((v) => typeof v === 'string' ? { value: keyify(v), label: v } : v),
  ...opts,
});
// Display-only pre-signed signature block. Renders in script font at
// the bottom of a form so every parent sees a consistent operator
// signature without the school having to wet-sign each copy.
const signatureStamp = (signer_name, signer_title, signed_date) =>
  ({ type: 'signature_stamp', signer_name, signer_title, signed_date });

const keyify = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);

// ── Standard e-sig consent text used by every form ──────────────────
const MCH_ESIG_CONSENT =
  'By typing my name below I agree to conduct business with Media Children\'s House by ' +
  'electronic means. I intend by typing my name below to "sign" the preceding document ' +
  'and to be bound by its terms and conditions.';

// ────────────────────────────────────────────────────────────────────
// 1. EMERGENCY CONTACT / PARENTAL CONSENT (PA 55 Code 3270.124)
// ────────────────────────────────────────────────────────────────────
function emergencyContactForm() {
  return {
    slug: 'mch-emergency-contact-consent',
    display_name: 'Emergency Contact / Parental Consent',
    description:
      'Pennsylvania-required form (55 PA Code Ch. 3270.124). Lists who to call if we ' +
      'can\'t reach you, who is authorized to pick up your child, key medical info, and ' +
      'your consent for routine activities. Re-submit any time information changes — ' +
      'we are required to refresh this at least every 6 months.',
    category: 'permission',
    per_student: true,
    confirmation_message:
      'Thanks! Your Emergency Contact form has been received and added to your child\'s file. ' +
      'The office will review and reach out only if anything needs clarification.',
    field_schema: [
      blockHeader('Emergency Contact / Parental Consent Form'),
      blockParagraph(
        'Required under 55 PA Code Ch. 3270.124(a)(b), 3270.181 & 182; 3280.124(a)(b), 3280.181 & 182; 3290.124(a)(b), 3290.181 & 182. ' +
        'All fields marked * are required — type "n/a" if not applicable.',
        'note',
      ),

      blockSection('Periodic Review',
        'PA Code requires this form to be refreshed every 6 months OR whenever your information changes. ' +
        'If you\'re submitting for the first time, pick "First submission." If you already have a form on file, ' +
        'pick "No changes" to confirm everything is still accurate, or "Update with changes" to edit any field below.'),
      radioF('review_mode',
        'Submission type',
        [
          { value: 'first_submission', label: 'First submission — no prior form on file for this child' },
          { value: 'no_changes',       label: 'Periodic review — everything on file is still accurate, no changes to make' },
          { value: 'has_changes',      label: 'Update with changes — I have updates to make to fields below' },
        ],
        { required: true,
          help: 'If you pick "Periodic review — no changes," scroll to the bottom and sign. ' +
                'If you pick "Update with changes," edit any field below; the office will be notified about exactly which fields changed.' }),

      blockSection('Child Information'),
      txt('child_name', 'Child\'s name', { required: true, placeholder: 'Type n/a if not applicable' }),
      dateF('child_birthdate', 'Birthdate', { required: true }),
      area('child_address', 'Address', { required: true, rows: 2, placeholder: 'Type n/a if not applicable' }),

      blockSection('Parent / Legal Guardian #1'),
      txt('p1_name', 'Name', { required: true, placeholder: 'Type n/a if not applicable' }),
      tel('p1_home_phone', 'Home phone', { required: true, placeholder: 'Type n/a if not applicable' }),
      tel('p1_cell', 'Cell number', { required: true, placeholder: 'Type n/a if not applicable' }),
      txt('p1_business_name', 'Business name', { required: true, placeholder: 'Type n/a if not applicable' }),
      tel('p1_business_phone', 'Business phone', { required: true, placeholder: 'Type n/a if not applicable' }),
      area('p1_business_address', 'Business address', { required: true, rows: 2, placeholder: 'Type n/a if not applicable' }),

      blockSection('Parent / Legal Guardian #2', 'Leave blank if not applicable.'),
      txt('p2_name', 'Name', { placeholder: 'Type n/a if not applicable' }),
      tel('p2_home_phone', 'Home phone', { placeholder: 'Type n/a if not applicable' }),
      tel('p2_cell', 'Cell number', { placeholder: 'Type n/a if not applicable' }),
      txt('p2_business_name', 'Business name', { placeholder: 'Type n/a if not applicable' }),
      tel('p2_business_phone', 'Business phone', { placeholder: 'Type n/a if not applicable' }),
      area('p2_business_address', 'Business address', { rows: 2, placeholder: 'Type n/a if not applicable' }),

      blockSection('Emergency Contact Person(s)',
        'People to contact if neither parent is reachable. Must be available during care hours.'),
      txt('ec1_name', 'Contact #1 name', { required: true, placeholder: 'Type n/a if not applicable' }),
      tel('ec1_phone', 'Contact #1 phone (during care hours)', { required: true, placeholder: 'Type n/a if not applicable' }),
      txt('ec2_name', 'Contact #2 name', { required: true, placeholder: 'Type n/a if not applicable' }),
      tel('ec2_phone', 'Contact #2 phone (during care hours)', { required: true, placeholder: 'Type n/a if not applicable' }),

      blockSection('Person(s) To Whom Child May Be Released',
        'Anyone authorized to pick up your child. MCH will not release the child to anyone not on this list without your written authorization. PA child care inspection requires a full mailing address (street, city, state, ZIP) for each release person.'),
      txt('r1_name', 'Release person #1 name', { required: true, placeholder: 'Type n/a if not applicable' }),
      tel('r1_phone', 'Release person #1 phone', { required: true, placeholder: 'Type n/a if not applicable' }),
      txt('r1_address_street', 'Release person #1 — street address',
        { required: true, placeholder: 'e.g. 123 Main St, Apt 4B' }),
      txt('r1_address_city', 'Release person #1 — city',
        { required: true, placeholder: 'e.g. Aston' }),
      txt('r1_address_state', 'Release person #1 — state (2-letter)',
        { required: true, placeholder: 'PA', max_length: 2 }),
      txt('r1_address_zip', 'Release person #1 — ZIP code',
        { required: true, placeholder: '19014', max_length: 10 }),
      txt('r2_name', 'Release person #2 name', { placeholder: 'Type n/a if not applicable' }),
      tel('r2_phone', 'Release person #2 phone', { placeholder: 'Type n/a if not applicable' }),
      txt('r2_address_street', 'Release person #2 — street address',
        { placeholder: 'e.g. 123 Main St, Apt 4B' }),
      txt('r2_address_city', 'Release person #2 — city',
        { placeholder: 'e.g. Aston' }),
      txt('r2_address_state', 'Release person #2 — state (2-letter)',
        { placeholder: 'PA', max_length: 2 }),
      txt('r2_address_zip', 'Release person #2 — ZIP code',
        { placeholder: '19014', max_length: 10 }),

      blockSection('Medical Information'),
      txt('physician_name', 'Physician / medical care provider name',
        { required: true, placeholder: 'Type n/a if not applicable' }),
      tel('physician_phone', 'Physician phone',
        { required: true, placeholder: 'Type n/a if not applicable' }),
      area('physician_address', 'Physician address',
        { required: true, rows: 2, placeholder: 'Type n/a if not applicable' }),
      area('special_disabilities', 'Special disabilities (if any)',
        { rows: 2, placeholder: 'Type n/a if not applicable' }),
      area('allergies', 'Allergies',
        { required: true, rows: 2, placeholder: 'Type n/a if not applicable' }),
      area('emergency_medical_info',
        'Medical or dietary information necessary in an emergency situation',
        { required: true, rows: 3, placeholder: 'Type n/a if not applicable' }),
      area('medication_special', 'Medication / special situation',
        { rows: 2, placeholder: 'Type n/a if not applicable' }),
      area('special_needs_info', 'Additional information on special needs of child',
        { rows: 2, placeholder: 'Type n/a if not applicable' }),
      txt('insurance_carrier', 'Health insurance coverage / medical assistance benefits',
        { required: true, placeholder: 'Type n/a if not applicable' }),
      txt('insurance_policy', 'Policy number',
        { required: true, placeholder: 'Type n/a if not applicable' }),

      blockSection('Parental Consents',
        'Each item below requires a typed signature to indicate consent. Type your full legal name to consent — leave blank to withhold.'),
      blockParagraph(
        'By typing my name below for each item, I authorize Media Children\'s House to act on my behalf for that activity.',
        'note',
      ),
      txt('consent_emergency_medical', 'Obtaining emergency medical care — typed signature', { required: true }),
      txt('consent_first_aid',          'Administration of minor first-aid procedures — typed signature', { required: true }),
      txt('consent_walks_trips',        'Walks and trips — typed signature'),
      // MCH does not offer swimming, but PA Code 3270.124(b)(5) lists it
      // as a required consent line item — pre-fill with "N/A" so parents
      // don't have to (and can't accidentally) sign for an activity that
      // never happens. They can edit if MCH ever adds swimming.
      txt('consent_swimming',           'Swimming — typed signature',
        { default: 'N/A',
          help: 'Media Children\'s House does not offer swimming. This field is pre-filled with "N/A" — no signature needed.' }),
      txt('consent_transportation',     'Transportation by the facility — typed signature'),
      txt('consent_wading',             'Wading — typed signature'),

      blockSection('Signature'),
      blockParagraph(MCH_ESIG_CONSENT, 'note'),
      txt('parent_signature', 'Parent / Guardian — type your full legal name to sign', { required: true }),
      dateF('signature_date', 'Date signed', { required: true }),

      blockSection('School Operator Signature',
        'Pre-signed by the Head of School on behalf of Media Children\'s House. No action needed from you.'),
      signatureStamp('Victoria Whitby', 'Head of School, Media Children\'s House', '2026-06-01'),
    ],
    notify_emails: [MCH_NOTIFY_EMAIL],
  };
}

// ────────────────────────────────────────────────────────────────────
// 2. ACT 90 — TEXTBOOK & INSTRUCTIONAL MATERIALS LOAN REQUEST
// ────────────────────────────────────────────────────────────────────
function act90Form() {
  return {
    slug: 'mch-act-90-textbook-request',
    display_name: 'Act 90 — Textbook Loan Request',
    description:
      'Pennsylvania Act 195 / Act 90 allows MCH to request textbooks and instructional ' +
      'materials on loan from the local public school district for non-public school ' +
      'students. The law requires each parent / guardian to individually request the ' +
      'loan. Sign once per child per school year. Pennsylvania residents only.',
    category: 'enrollment',
    per_student: true,
    // Kindergarten-only: Act 195/90 textbook loan is a K-12 entitlement.
    // MCH has no kindergarten program/grid (K is the oldest year of the
    // Primary classroom), so the K cohort is a hand-picked roster the
    // school supplies — set out-of-band as applies_to.student_ids via
    // scripts/set-mch-kindergarten-forms.mjs. No applies_to here so the
    // seed's COALESCE preserves that data-driven list on re-seed.
    confirmation_message:
      'Thanks! Your Act 90 / 195 textbook loan request has been received. MCH will ' +
      'forward the request to your local public school district.',
    field_schema: [
      blockHeader('Certificate of Individual Request for Loan of Textbooks and Instructional Materials'),
      blockParagraph(
        'Pennsylvania state law (Act 195) authorizes the loan of textbooks by the Secretary of Education ' +
        'to children enrolled in non-public schools. State law (Act 90) authorizes the loan of instructional ' +
        'materials. Media Children\'s House requests these materials on behalf of your child, but the law ' +
        'requires that each parent / guardian individually request the loan.',
      ),
      blockParagraph(
        'This law is applicable to Pennsylvania residents only.',
        'warning',
      ),

      blockSection('Request'),
      blockParagraph(
        'I hereby request the loan of textbooks and instructional materials in accordance with Acts 90 & 195 ' +
        'for my child attending Media Children\'s House Montessori School.',
      ),
      txt('child_name', 'Child\'s name', { required: true }),

      blockSection('Signature'),
      blockParagraph(MCH_ESIG_CONSENT, 'note'),
      txt('parent_signature', 'Parent / Guardian — type your full legal name to sign', { required: true }),
      dateF('signature_date', 'Date signed', { required: true }),
    ],
    notify_emails: [MCH_NOTIFY_EMAIL],
  };
}

// ────────────────────────────────────────────────────────────────────
// 3. DHS AGREEMENT — Extended Care Fee (school year)
// ────────────────────────────────────────────────────────────────────
function dhsAgreementForm() {
  return {
    slug: 'mch-dhs-agreement',
    display_name: 'DHS Agreement — Extended Care (School Year)',
    // Visible to: (a) Young Community / Toddler kids — they're enrolled
    // in DHS-licensed child care by default, and (b) anyone who selected
    // extended care (before-care, after-care, or both) on their
    // enrollment paperwork — those services trigger the DHS agreement
    // even for older Primary / Kindergarten students. Plain half-day
    // Primary kids without extended care skip it.
    applies_to: {
      program_match: ['young community'],
      metadata_match: {
        aftercare: ['before', 'after', 'both', 'full'],
      },
    },
    description:
      'Pennsylvania DHS-required care agreement (55 PA Code Ch. 3270.123 & .181). ' +
      'Sets the Extended Care fee, arrival / departure times, and authorized release ' +
      'persons. Required at admission and at each periodic review.',
    category: 'enrollment',
    per_student: true,
    confirmation_message:
      'Thanks! Your DHS Extended Care Agreement has been received and added to your child\'s file.',
    field_schema: [
      blockHeader('DHS Agreement — Extended Care Fee'),
      blockParagraph('55 PA Code Ch. 3270.123 & .181(C); 3280.123 & .181(c); 3290.123 & .181(c).', 'note'),

      blockSection('Care Fee',
        'Pre-filled from your enrollment paperwork. Contact the office if anything looks wrong.'),
      blockParagraph(
        'Services included: Childcare, after-school snack, developmentally appropriate activities, ' +
        'and diapering for toddlers. Payment due on the 15th of each month, July through April.',
      ),
      txt('fee_amount',  'Extended care fee — annual ($)',
        { prefill: 'enrollment.extended_care_dollars', readOnly: true,
          help: 'Your annual extended-care fee, from your enrollment record. Blank if you have no separate extended-care fee.' }),
      txt('per_payment', 'Per payment ($)',
        { prefill: 'enrollment.extended_care_monthly_dollars', readOnly: true,
          help: 'Annual extended-care fee ÷ 10 monthly payments (July–April).' }),

      blockSection('Days & Hours of Attendance',
        'Your child\'s scheduled days and arrival / departure times, from your enrollment paperwork.'),
      txt('attendance_days', 'Days of attendance',
        { required: true, prefill: 'enrollment.schedule_days', readOnly: true }),
      txt('arrival_time',   'Child\'s arrival time',
        { required: true, prefill: 'enrollment.arrival_time', readOnly: true }),
      txt('departure_time', 'Child\'s departure time',
        { required: true, prefill: 'enrollment.departure_time', readOnly: true }),
      blockParagraph(
        'Late fees: $1.00 per minute after 10 minutes past scheduled pick-up. $35.00 flat fee after 5:30 PM.',
        'warning',
      ),

      blockSection('Persons Designated by Parents to Whom Child May Be Released',
        'List anyone authorized to pick up your child during extended care. Use full legal name.'),
      txt('release_person_1', 'Release person #1 — Name & relationship', { required: true }),
      tel('release_person_1_phone', 'Release person #1 phone', { required: true }),
      txt('release_person_2', 'Release person #2 — Name & relationship'),
      tel('release_person_2_phone', 'Release person #2 phone'),
      txt('release_person_3', 'Release person #3 — Name & relationship'),
      tel('release_person_3_phone', 'Release person #3 phone'),

      blockSection('Required Acknowledgments'),
      checkboxF('ack_program_info_received',
        'I received complete written program information at the time of enrollment ' +
        '(55 PA Code 3270.121, 3280.121, 3290.121).',
        { required: true }),
      checkboxF('ack_six_month_update',
        'I agree to update the Emergency Contact / Parental Consent Form information whenever ' +
        'changes occur or every 6 months at a minimum (55 PA Code 3270.124, 3280.124, 3290.124).',
        { required: true }),

      blockSection('Dates'),
      // Date of admission is set per-student by school staff (Melody)
      // via the admin UI and synced to GHL custom field
      // student_date_of_admission. The form prefills it so parents
      // don't have to know the date themselves.
      dateF('admission_date', 'Date of child\'s admission',
        { required: true, prefill: 'student.date_of_admission',
          help: 'Pre-filled from your child\'s enrollment record. Contact the office if this looks wrong.' }),

      blockSection('Signature'),
      blockParagraph(MCH_ESIG_CONSENT, 'note'),
      txt('parent_signature', 'Parent / Guardian — type your full legal name to sign', { required: true }),
      dateF('signature_date', 'Date signed', { required: true }),
    ],
    notify_emails: [MCH_NOTIFY_EMAIL],
  };
}

// ────────────────────────────────────────────────────────────────────
// 4. DHS AGREEMENT — Summer Camp Care Fee
// ────────────────────────────────────────────────────────────────────
function dhsAgreementSummerForm() {
  return {
    slug: 'mch-dhs-agreement-summer-camp',
    display_name: 'DHS Agreement — Summer Camp',
    description:
      'Pennsylvania DHS-required care agreement for the Summer Camp program. Sets ' +
      'the Summer Camp fee, scheduled weeks / days, arrival / departure times, and ' +
      'authorized release persons. Required before camp start.',
    category: 'enrollment',
    per_student: true,
    confirmation_message:
      'Thanks! Your Summer Camp DHS Agreement has been received. The office will follow up if ' +
      'anything needs clarification before camp starts.',
    field_schema: [
      blockHeader('DHS Agreement — Summer Camp Care Fee'),
      blockParagraph('55 PA Code Ch. 3270.123 & .181(C); 3280.123 & .181(c); 3290.123 & .181(c).', 'note'),

      blockSection('Child & Fee'),
      txt('child_name', 'Name of child', { required: true }),
      txt('fee_amount', 'Fee amount ($)', { required: true }),
      blockParagraph(
        'Payment dates: May 15, 2026 & June 15, 2026.',
        'note',
      ),

      blockSection('Services Provided'),
      blockParagraph(
        'Childcare, weekly themed lessons / activities, and recording of each child\'s ' +
        'activities. Diapering / toileting will be recorded for Young Community Services.',
      ),
      blockParagraph(
        'No refunds or credits will be given for any schedule adjustments made after May 31, 2026. ' +
        'After that date, payment is due for any weeks / days your child has been signed up for, ' +
        'whether or not they are able to attend — staff schedules are finalized by then.',
        'warning',
      ),
      blockParagraph('Late fees: $1.00 per minute beginning 10 minutes after scheduled pick-up time.', 'warning'),

      blockSection('Schedule'),
      timeF('arrival_time',   'Child\'s arrival time',   { required: true }),
      timeF('departure_time', 'Child\'s departure time', { required: true }),
      area('attendance_weeks',
        'Days of attendance — list the weeks & days your child will attend',
        { required: true, rows: 3, placeholder: 'e.g. Weeks of June 15, June 22, July 6 — Mon/Wed/Fri' }),
      // Date of admission auto-fills from student.metadata.date_of_admission
      // (set by school staff in the admin UI / synced from GHL).
      dateF('admission_date', 'Date of child\'s admission',
        { required: true, prefill: 'student.date_of_admission',
          help: 'Pre-filled from your child\'s enrollment record. Contact the office if this looks wrong.' }),

      blockSection('Persons Designated by Parents to Whom Child May Be Released',
        'List anyone authorized to pick up your child during camp.'),
      txt('release_person_1', 'Release person #1 — Name & relationship', { required: true }),
      tel('release_person_1_phone', 'Release person #1 phone', { required: true }),
      txt('release_person_2', 'Release person #2 — Name & relationship'),
      tel('release_person_2_phone', 'Release person #2 phone'),
      txt('release_person_3', 'Release person #3 — Name & relationship'),
      tel('release_person_3_phone', 'Release person #3 phone'),

      blockSection('Required Acknowledgments'),
      checkboxF('ack_program_info_received',
        'I received complete written program information at the time of enrollment ' +
        '(55 PA Code 3270.121, 3280.121, 3290.121).',
        { required: true }),
      checkboxF('ack_six_month_update',
        'I agree to update the Emergency Contact / Parental Consent Form information whenever ' +
        'changes occur or every 6 months at a minimum (55 PA Code 3270.124, 3280.124, 3290.124).',
        { required: true }),

      blockSection('Signature'),
      blockParagraph(MCH_ESIG_CONSENT, 'note'),
      txt('parent_signature', 'Parent / Guardian — type your full legal name to sign', { required: true }),
      dateF('signature_date', 'Date signed', { required: true }),
    ],
    notify_emails: [MCH_NOTIFY_EMAIL],
  };
}

// ────────────────────────────────────────────────────────────────────
// 5. CHILD HEALTH REPORT (CD-51, hybrid)
// ────────────────────────────────────────────────────────────────────
function childHealthReportForm() {
  return {
    slug: 'mch-child-health-report',
    display_name: 'Child Health Report (CD-51)',
    description:
      'Pennsylvania-required physical health form (55 PA Code §§3270.131, 3280.131, ' +
      '3290.131). Must be completed by your child\'s pediatrician and includes the ' +
      'date of the last physical + immunization record. Valid for 1 year from the ' +
      'doctor\'s signature date. Required within 30 days of attendance and renewed ' +
      'annually. Upload the doctor-signed form here.',
    category: 'medical',
    per_student: true,
    confirmation_message:
      'Thanks! Your Child Health Report has been received. We\'ll review it within 1 business day ' +
      'and contact you only if anything is incomplete or expiring soon.',
    field_schema: [
      blockHeader('Child Health Report'),
      blockParagraph(
        'This form is the standard Pennsylvania CD-51 health report (55 PA Code §§3270.131, 3280.131, 3290.131). ' +
        'Your pediatrician fills out the medical sections and signs at the bottom. Upload the completed PDF below.',
      ),
      blockParagraph(
        'If your doctor\'s office uses their own physical form, that\'s acceptable in lieu of the CD-51 — ' +
        'just make sure it includes the date of the physical, immunization record, and the doctor\'s signature.',
        'note',
      ),
      blockParagraph(
        'Don\'t have the form? Download the CD-51 from the school office or your child\'s pediatrician.',
        'note',
      ),

      blockSection('Child & Parent'),
      txt('child_name',   'Child\'s full name', { required: true }),
      dateF('child_dob',  'Date of birth',      { required: true }),
      txt('parent_name',  'Parent / Guardian',  { required: true }),
      area('child_address', 'Address',          { required: true, rows: 2 }),
      tel('home_phone',   'Home phone',         { required: true }),
      tel('work_phone',   'Work phone'),

      blockSection('Authorization'),
      checkboxF('authorize_communication',
        'I authorize the child care staff and my child\'s health professional to ' +
        'communicate directly if needed to clarify information on this form about my child.',
        { required: true }),

      blockSection('Health Report Upload'),
      fileF('health_report_file',
        'Upload completed CD-51 (or equivalent), signed by the physician',
        { required: true, accept: '.pdf,.jpg,.jpeg,.png',
          help: 'PDF, JPG, or PNG up to 10 MB. Must include doctor\'s signature & date.' }),
      dateF('physical_exam_date', 'Date of last physical exam (on the form)', { required: true }),

      blockSection('Signature'),
      blockParagraph(MCH_ESIG_CONSENT, 'note'),
      txt('parent_signature', 'Parent / Guardian — type your full legal name to sign', { required: true }),
      dateF('signature_date', 'Date signed', { required: true }),
    ],
    notify_emails: [MCH_NOTIFY_EMAIL],
  };
}

// ────────────────────────────────────────────────────────────────────
// 6. DENTAL EXAM FORM (hybrid)
// ────────────────────────────────────────────────────────────────────
function dentalExamForm() {
  return {
    slug: 'mch-dental-exam',
    display_name: 'Dental Exam Form',
    description:
      'Pennsylvania health regulations require Kindergarten and 3rd-grade students ' +
      'to have a dental exam prior to entry. Your dentist fills out the form and ' +
      'signs — upload the completed PDF here before your child\'s first day.',
    category: 'medical',
    per_student: true,
    // Kindergarten-only: PA Department of Health Act 28 dental exam
    // requirement is for K + 3rd grade. MCH's K cohort is a hand-picked
    // roster (no kindergarten grid in the data) supplied by the school
    // and set out-of-band as applies_to.student_ids via
    // scripts/set-mch-kindergarten-forms.mjs. No applies_to here so the
    // seed's COALESCE preserves that list on re-seed.
    confirmation_message:
      'Thanks! Your dental exam form has been received and added to your child\'s file.',
    field_schema: [
      blockHeader('Dental Exam Form'),
      blockParagraph(
        'Pennsylvania health regulations require Kindergarten and 3rd-grade students to have ' +
        'a dental exam prior to entrance. Your dentist completes the form and signs at the bottom; ' +
        'upload the completed PDF here.',
      ),

      blockSection('Child Information'),
      txt('child_name',  'Child\'s name',  { required: true }),
      dateF('child_dob', 'Date of birth',  { required: true }),
      dateF('exam_date', 'Date of dental exam (on the form)', { required: true }),
      radioF('corrections_made',
        'At that time were all necessary corrections made?',
        ['Yes', 'No', 'Follow-up needed'],
        { required: true }),

      blockSection('Form Upload'),
      fileF('dental_form_file',
        'Upload completed dental exam form, signed by the dentist',
        { required: true, accept: '.pdf,.jpg,.jpeg,.png',
          help: 'PDF, JPG, or PNG up to 10 MB. Must include the dentist\'s signature & date.' }),

      blockSection('Signature'),
      blockParagraph(MCH_ESIG_CONSENT, 'note'),
      txt('parent_signature', 'Parent / Guardian — type your full legal name to sign', { required: true }),
      dateF('signature_date', 'Date signed', { required: true }),
    ],
    notify_emails: [MCH_NOTIFY_EMAIL],
  };
}

// ────────────────────────────────────────────────────────────────────
// 7. MEDICATION LOG / AUTHORIZATION
// ────────────────────────────────────────────────────────────────────
function medicationLogForm() {
  return {
    slug: 'mch-medication-log',
    display_name: 'Medication Authorization',
    description:
      'Required if you want sunscreen, bug spray, or any medication (prescription or ' +
      'over-the-counter) administered to your child at school or during summer camp. ' +
      'Re-submit any time the medication or dosage changes.',
    category: 'medical',
    per_student: true,
    confirmation_message:
      'Thanks! Your medication authorization has been received and will be on file with the ' +
      'front desk before the start date.',
    field_schema: [
      blockHeader('Medication Authorization'),
      blockParagraph(
        'Use this form for sunscreen / bug spray during summer camp, or prescription / ' +
        'over-the-counter medication during the school day.',
      ),

      blockSection('Child'),
      txt('child_name', 'Child\'s name', { required: true }),

      blockSection('Medication'),
      txt('medication_name', 'Medication name', { required: true,
        placeholder: 'e.g. Mineral sunscreen SPF 50, OFF! bug spray, Children\'s Tylenol' }),
      radioF('medication_type',
        'Type',
        ['Prescription', 'Non-prescription'],
        { required: true }),
      radioF('refrigeration_required',
        'Refrigeration required?',
        ['Yes', 'No', 'N/A — not necessary for sunscreen'],
        { required: true }),

      blockSection('Prescription Details',
        'Fill these out only if this is a prescription medication. Otherwise leave blank.'),
      txt('prescriber_name', 'Prescriber\'s name'),
      tel('prescriber_phone', 'Prescriber\'s phone'),

      blockSection('Administration'),
      txt('dosage_amount', 'Dosage amount',
        { required: true, placeholder: 'e.g. 1 tsp, 2 sprays, apply to face & arms' }),
      txt('time_to_administer',
        'Time(s) to administer (specify AM/PM)',
        { required: true, placeholder: 'e.g. 10:30 AM and 1:00 PM, or "Before outside play"' }),
      numF('times_per_day',
        'Times per day',
        { required: true, min: 1, max: 24,
          placeholder: 'e.g. 2' }),
      dateF('start_date', 'Administer from (start date)', { required: true }),
      dateF('end_date',   'Administer to (end date)',     { required: true }),
      area('special_instructions',
        'Special instructions (symptoms signaling need, indications, reasons to hold, contraindications)',
        { rows: 3, placeholder: 'Type n/a if none' }),

      blockSection('Permission'),
      blockParagraph(
        'I give permission to administer the medication described above to my child as stated.',
      ),
      blockParagraph(MCH_ESIG_CONSENT, 'note'),
      txt('parent_signature', 'Parent / Guardian — type your full legal name to sign', { required: true }),
      dateF('signature_date', 'Date signed', { required: true }),
    ],
    notify_emails: [MCH_NOTIFY_EMAIL],
  };
}

// ────────────────────────────────────────────────────────────────────
// 8. PARENT HANDBOOK ACKNOWLEDGMENT
// ────────────────────────────────────────────────────────────────────
function parentHandbookAckForm() {
  return {
    slug: 'mch-parent-handbook-acknowledgment',
    display_name: 'Parent Handbook Acknowledgment (2026–2027 School Year)',
    description:
      'Annual acknowledgment that you have received and read the Parent Handbook and ' +
      'Nondiscrimination Policy. Required once per family at the start of the school year.',
    category: 'enrollment',
    per_student: false, // one signing per family, not per child
    confirmation_message:
      'Thanks! Your handbook acknowledgment has been recorded for the 2026–2027 school year.',
    field_schema: [
      blockHeader('Parent Handbook Acknowledgment'),
      blockParagraph('September 2026 – June 2027 School Year', 'note'),

      blockSection('Acknowledgment'),
      blockParagraph(
        'I, the undersigned, acknowledge that I have received a copy of the Parent Handbook and the ' +
        'Nondiscrimination Policy for Media Children\'s House. While I understand that this document is ' +
        'neither a contract nor legal document, I recognize that it is my responsibility to read and ' +
        'understand the policies, provisions, and procedures contained in the documents.',
      ),
      blockParagraph(
        'In addition, I understand that the contents of this document are subject to change. I acknowledge ' +
        'that the Parent Handbook will be revised in accordance with the rules or regulations of state, federal, ' +
        'or accrediting entities, best practices for childcare service providers, or at the discretion of the ' +
        'Board of Media Children\'s House. I recognize that any such revisions will supersede, modify, or ' +
        'eliminate the current contents of the Parent Handbook.',
      ),
      blockParagraph(
        'I acknowledge that it is my responsibility to stay informed of policy and procedure revisions to ' +
        'the Parent Handbook which will be emailed by Media Children\'s House to the undersigned.',
      ),
      blockParagraph(
        'In the event that I do not have internet access, I understand that I can obtain a hard copy of the ' +
        'updated Parent Handbook and Nondiscrimination Policy upon request to Media Children\'s House. ' +
        'Moreover, I recognize that it is my responsibility to contact the Director or Assistant Director ' +
        'for any questions I might have about the contents of the Parent Handbook or Nondiscrimination ' +
        'Policy now and in the future.',
      ),
      blockParagraph(
        'If at any point I am unable to comply with the policies within the Parent Handbook, I understand ' +
        'that my child may be removed from the program.',
        'warning',
      ),

      blockSection('Signature'),
      checkboxF('confirm_received',
        'I confirm that I have received and read the Parent Handbook and Nondiscrimination Policy.',
        { required: true }),
      blockParagraph(MCH_ESIG_CONSENT, 'note'),
      txt('parent_signature', 'Parent / Guardian — type your full legal name to sign', { required: true }),
      dateF('signature_date', 'Date signed', { required: true }),
    ],
    notify_emails: [MCH_NOTIFY_EMAIL],
  };
}

// ────────────────────────────────────────────────────────────────────
// 9. PRESS RELEASE — Photo / Media Consent
// ────────────────────────────────────────────────────────────────────
function pressReleaseForm() {
  return {
    slug: 'mch-press-release',
    display_name: 'Press Release / Photo Consent',
    description:
      'Permission for MCH to photograph your child during school activities and use ' +
      'the images on school communications. Effective for the entirety of your child\'s ' +
      'enrollment — re-submit only if your preferences change.',
    category: 'permission',
    per_student: true,
    // Per the school's Form Distribution matrix: Press Release goes to
    // NEW students only. metadata.is_new = 'new' is set by the importer
    // for first-year enrollments.
    applies_to: { metadata_match: { is_new: ['new'] } },
    confirmation_message:
      'Thanks! Your photo / media preferences have been recorded for the duration of your child\'s enrollment.',
    field_schema: [
      blockHeader('Press Release / Photo Consent'),
      blockParagraph(
        'Throughout the year, Media Children\'s House takes photographs of children participating ' +
        'in various school activities. Please check the boxes below for the uses you agree to. ' +
        'Leave a box unchecked to withhold consent for that use.',
      ),

      blockSection('Child'),
      txt('child_name', 'Child\'s name', { required: true }),

      blockSection('Permission Items',
        'Check each item you agree to. Unchecked items mean consent is withheld for that use.'),
      checkboxF('consent_parent_app',
        'Media Children\'s House has my permission to use my child\'s image on the school\'s parent communications app.'),
      checkboxF('consent_newspaper',
        'Media Children\'s House has my permission to use my child\'s name, image, and hometown in newspaper articles and polls.'),
      checkboxF('consent_press_advertising',
        'Media Children\'s House has my permission to use my child\'s image for press releases and advertising campaigns.'),
      checkboxF('consent_website_blog',
        'Media Children\'s House has my permission to use my child\'s image on www.mediachildrenshouse.com and the Media Children\'s House blog.'),
      checkboxF('consent_facebook',
        'Media Children\'s House has my permission to use my child\'s image on the school\'s Facebook page.'),
      checkboxF('consent_yearbook',
        'I would like images of my child to be included in Media Children\'s House\'s yearbook. I hereby allow my child to be photographed during the school day and school events for inclusion in the yearbook.'),

      blockSection('Acknowledgment'),
      blockParagraph(
        'I understand that Media Children\'s House will be enlisting professional photography / video ' +
        'services to document school events throughout the school year and that my child\'s likeness may ' +
        'appear in photographs and video clips unless I personally take measures to ensure they are not ' +
        'included. I understand that to ensure full coverage of events, photographers / videographers cannot ' +
        'be asked to work around my child as their primary focus is thorough coverage of the activity / event ' +
        'for Media Children\'s House.',
      ),
      blockParagraph(
        'This press release will be effective for the entirety of the child\'s enrollment at Media Children\'s House.',
        'note',
      ),
      checkboxF('confirm_acknowledgment',
        'I acknowledge that I have read and understand the above.',
        { required: true }),

      blockSection('Signature'),
      blockParagraph(MCH_ESIG_CONSENT, 'note'),
      txt('parent_signature', 'Parent / Guardian — type your full legal name to sign', { required: true }),
      dateF('signature_date', 'Date signed', { required: true }),
    ],
    notify_emails: [MCH_NOTIFY_EMAIL],
  };
}

// ────────────────────────────────────────────────────────────────────
// 10. POTTY TRAINING POLICY ACKNOWLEDGMENT
// ────────────────────────────────────────────────────────────────────
function pottyTrainingAckForm() {
  return {
    slug: 'mch-potty-training-acknowledgment',
    display_name: 'Potty Training Policy Acknowledgment',
    description:
      'Required for children transitioning from the Toddler Program to the Primary ' +
      'Program (ages 3-6). Acknowledges that the child must be fully potty trained per ' +
      'the policy below before entering Primary.',
    category: 'enrollment',
    per_student: true,
    confirmation_message:
      'Thanks! Your potty training policy acknowledgment has been recorded.',
    field_schema: [
      blockHeader('Transition Requirements — Potty Training'),
      blockParagraph(
        'Below are the guidelines from our Parent Handbook which help parents know when their child ' +
        'is ready to transition from the Toddler Program to the Primary Program. Most of these changes ' +
        'will occur at the beginning of Summer Camp or in September if the child meets the criteria.',
      ),

      blockSection('Promotion from One Level to the Next',
        'A student at MCH proceeds at his/her own pace. We take each child\'s academic, social, ' +
        'emotional, and physical development into consideration when making a promotion decision. ' +
        'In addition to evaluating the child\'s total development, the following guidelines apply:'),
      blockParagraph(
        '• Children should be 3 by September 1 of the upcoming school year\n' +
        '• Children should be potty-trained (per the policy below)\n' +
        '• Children should be able to interact with other students, guides, and other adults',
      ),

      blockSection('Potty Training Policy'),
      blockParagraph(
        'Media Children\'s House requires that children entering the Primary Program (3-6) are potty ' +
        'trained. MCH is not a daycare and the primary classrooms are not equipped for ' +
        'diapering / potty training.',
      ),
      blockParagraph(
        'A potty-trained child:\n\n' +
        '• Will tell the teacher they need to go to the bathroom before needing to go\n' +
        '• Is able to go to the bathroom (urinating or bowel movement) on his/her own — including ' +
        'removing clothing, sitting on the toilet, wiping himself/herself using an appropriate amount of ' +
        'toilet paper, putting clothing back on, flushing the toilet, and washing and drying hands\n' +
        '• Is fully aware of using the toilet without reminders from the teachers (although teachers do ' +
        'make requests at various times of the day — before/after meals and before going to the playground)\n' +
        '• Does not wear pull-ups or diapers — he/she must be in regular underwear\n' +
        '• Is able to postpone going if waiting for someone else who is in the bathroom or if we are outside',
      ),
      blockParagraph(
        'The Primary Program does not have the staffing to potty train students. The ratios required for ' +
        'primary students are higher than a toddler classroom and do not allow for potty training or diapering. ' +
        'Diapering stations are a licensing requirement for programs that change diapers, with strict standards ' +
        'for changing and disposing of soiled diapers / clothing — that doesn\'t fall within the licensing ' +
        'requirements for a Private Academic School.',
      ),
      blockParagraph(
        'Accidents happen — that\'s why each child should have an extra pair of clothes at school. However, ' +
        'if your child has accidents frequently, we do not consider them potty-trained. If after the first few ' +
        'weeks of school the situation is not manageable within the classroom environment, we will discuss the ' +
        'issue with the parents. Considerations may include having the child return to Young Community ' +
        '(toddler program) until potty trained. If no room is available in Young Community, MCH reserves the ' +
        'right to suspend attendance from Primary until the child is fully potty trained.',
        'warning',
      ),
      blockParagraph(
        'MCH reserves the right to have a transition meeting with parents of students who are due to move ' +
        'up to the Primary Program in order to make a determination as to whether the student is truly ready ' +
        'and fully potty trained.',
      ),

      blockSection('Acknowledgment'),
      txt('child_name', 'Child\'s name', { required: true }),
      checkboxF('confirm_acknowledgment',
        'I have read the above potty-training requirements for entrance into the Primary Program at MCH ' +
        'and will fully abide by the policies outlined above.',
        { required: true }),

      blockSection('Signature'),
      blockParagraph(MCH_ESIG_CONSENT, 'note'),
      txt('parent_signature', 'Parent / Guardian — type your full legal name to sign', { required: true }),
      dateF('signature_date', 'Date signed', { required: true }),
    ],
    notify_emails: [MCH_NOTIFY_EMAIL],
  };
}

// ────────────────────────────────────────────────────────────────────
// 11. HOLIDAY QUESTIONNAIRE FOR PARENTS — Celebrating Diversity & Inclusion
// ────────────────────────────────────────────────────────────────────
// Per-family (not per-student): a family answers ONE questionnaire
// even when multiple kids are enrolled. Resubmissions allowed so the
// office can ask families to update mid-year if culture/preferences
// change.
function holidayQuestionnaireForm() {
  return {
    slug: 'mch-holiday-questionnaire',
    display_name: 'Holiday Questionnaire — Celebrating Diversity & Inclusion',
    description:
      'Our classroom community is enriched by the many cultures, traditions, languages, ' +
      'and celebrations represented in our families. Your answers help us respectfully ' +
      'acknowledge holidays and traditions in ways that support inclusion, understanding, ' +
      'and Montessori values.',
    category: 'permission',
    per_student: false,
    confirmation_message:
      'Thank you for helping us create a respectful, inclusive, and joyful learning ' +
      'environment for every child and family.',
    field_schema: [
      blockHeader('Holiday Questionnaire for Parents'),
      blockParagraph(
        'Media Children\'s House — Celebrating Diversity & Inclusion',
        'note',
      ),
      blockParagraph(
        'Dear Families, our classroom community is enriched by the many cultures, traditions, ' +
        'languages, and celebrations represented in our families. This questionnaire will ' +
        'help us respectfully acknowledge holidays and traditions in ways that support ' +
        'inclusion, understanding, and Montessori values.',
      ),

      blockSection('Family Information'),
      txt('child_name',
        'Child\'s name (or names — list all enrolled children)',
        { required: true, prefill: 'student.full_name',
          help: 'For multiple children, list all enrolled at MCH.' }),
      txt('parent_guardian_names',
        'Parent / Guardian name(s)',
        { required: true, prefill: 'parent.full_name' }),
      txt('preferred_languages',
        'Preferred language(s) spoken at home',
        { required: true, placeholder: 'e.g. English, Spanish' }),

      blockSection('Celebrations & Traditions'),
      radioF('celebrates_holidays',
        'Does your family celebrate any cultural, religious, or seasonal holidays?',
        ['Yes', 'No'],
        { required: true }),
      area('holidays_list',
        'If yes, please list them',
        { help: 'List any cultural, religious, or seasonal holidays your family observes.' }),
      area('meaningful_traditions',
        'Which holidays or traditions are especially meaningful to your family?',
        { rows: 3 }),
      radioF('comfortable_sharing',
        'Are there any customs, foods, music, clothing, stories, or activities connected to these celebrations that you would be comfortable sharing with the class?',
        ['Yes', 'No'],
        { required: true }),
      area('sharing_description',
        'If yes, please describe',
        { rows: 3, help: 'Describe what you\'d be comfortable sharing — recipes, songs, photos, stories, etc.' }),

      blockSection('Participation & Inclusion'),
      multiCheckboxF('participation_interest',
        'Would you be interested in any of the following? (Check all that apply)',
        [
          'Visiting the classroom to share a tradition or story',
          'Sharing photos, music, or artifacts',
          'Helping with a multicultural event',
          'Sending in a traditional food or recipe',
          'Not participating at this time',
        ]),
      radioF('opt_out_holidays',
        'Are there any holidays or activities you prefer your child NOT participate in?',
        ['Yes', 'No'],
        { required: true }),
      area('opt_out_explanation',
        'If yes, please explain',
        { rows: 3, help: 'Helps our teachers respect your family\'s wishes during classroom celebrations.' }),

      blockSection('Family Values & Perspectives'),
      area('cultural_understanding',
        'What would you like teachers and classmates to understand about your family\'s culture or traditions?',
        { rows: 4 }),
      area('non_holiday_traditions',
        'Are there important family traditions that are not tied to a holiday but are meaningful to your family?',
        { rows: 3 }),
      area('school_improvement_ideas',
        'How can our school better support diversity, inclusion, and respect for all families?',
        { rows: 4 }),

      blockSection('Signature'),
      blockParagraph(MCH_ESIG_CONSENT, 'note'),
      txt('parent_signature',
        'Parent / Guardian — type your full legal name to sign',
        { required: true, prefill: 'parent.full_name' }),
      dateF('signature_date',
        'Date signed',
        { required: true, prefill: 'today' }),
    ],
    notify_emails: [MCH_NOTIFY_EMAIL],
  };
}

// ────────────────────────────────────────────────────────────────────
// 12. VOLUNTEER OPPORTUNITIES 2026
// ────────────────────────────────────────────────────────────────────
// Per-family interest survey for MCH's 8 standing volunteer areas
// (Holiday Parties, Mystery Readers, Concert Assistance, Office/
// Material Making, Community Service, Gardening, Cultural Studies,
// Substitute List). Office uses this to build the volunteer roster
// each year. Resubmissions allowed so families can update mid-year.
function volunteerOpportunitiesForm() {
  return {
    slug: 'mch-volunteer-opportunities-2026',
    display_name: 'Volunteer Opportunities — 2026-2027',
    description:
      'Sign up for the ways you\'d like to support our school community this year. ' +
      'Even 15 minutes here and there makes a difference — pick as many as you\'d like.',
    category: 'permission',
    per_student: false,
    confirmation_message:
      'Thanks for offering to help! The MCH office will follow up with details on the ' +
      'opportunities you selected as each one comes up during the year.',
    field_schema: [
      blockHeader('Make a Difference… Volunteer'),
      blockParagraph(
        'Are you interested in volunteering at Media Children\'s House? We welcome and ' +
        'encourage parents and family members to volunteer in a number of areas. Even if ' +
        'you\'re short on time and only have 15 minutes to share, we can accommodate you! ' +
        'Here at MCH we believe that parent involvement is an integral part of our community.',
      ),

      blockSection('Your Information'),
      txt('parent_name',
        'Your name',
        { required: true, prefill: 'parent.full_name' }),
      txt('parent_email',
        'Best email to reach you',
        { required: true, prefill: 'parent.email' }),
      tel('parent_phone',
        'Best phone to reach you',
        { prefill: 'parent.phone',
          help: 'Optional — we\'ll use email by default.' }),

      blockSection('Volunteer Opportunities',
        'Select every area you\'re interested in. The office will follow up with details as each one comes up.'),
      multiCheckboxF('interested_opportunities',
        'I\'d like to help with: (check all that apply)',
        [
          { value: 'holiday_parties',
            label: 'Holiday Parties — help out in the classrooms during various parties throughout the year' },
          { value: 'mystery_readers',
            label: 'Mystery Readers — read to your child\'s class (children won\'t know who is coming until you arrive!)' },
          { value: 'concert_assistance',
            label: 'Concert Assistance — set up + break down for the Winter and Spring concerts at the Aston Community Center' },
          { value: 'office_material_making',
            label: 'Office / Material Making — cut, laminate, staple, and sort classroom materials (great if school-hours volunteering doesn\'t fit your schedule)' },
          { value: 'community_service',
            label: 'Community Service Projects — help coordinate outreach events in our local area' },
          { value: 'gardening',
            label: 'Gardening — share your green thumb with the children outdoors' },
          { value: 'cultural_studies',
            label: 'Cultural Studies / Lunch Around the World — share an instrument, art, recipe, or travel story with the class' },
          { value: 'substitute_list',
            label: 'Substitute List — be a paid temporary sub when a teacher can\'t make it (training provided; criminal background check required)' },
        ],
        { required: true,
          help: 'Pick as many as you\'d like — even a single one helps.' }),

      blockSection('Holiday Parties (optional details)',
        'If you ticked Holiday Parties above, which holidays interest you most? Skip if you don\'t have a preference.'),
      multiCheckboxF('holiday_party_interests',
        'I\'d especially like to help with: (optional)',
        [
          'Halloween / Fall Celebration',
          'Thanksgiving / Harvest Feast',
          'Winter Holidays / Solstice',
          'Valentine\'s Day',
          'Spring Celebration / Earth Day',
          'End-of-Year Celebration',
          'No preference — any of them',
        ]),

      blockSection('Anything Else',
        'Other ways you\'d like to be involved, or skills / talents we should know about.'),
      area('skills_to_share',
        'Skills, talents, or experiences you\'d like to share',
        { rows: 3,
          help: 'e.g. "I\'m a nurse and could give a kindergarten-friendly health talk", "I speak Mandarin and could read a children\'s book in it", "I\'m a beekeeper."' }),
      area('other_notes',
        'Other notes or questions for the office',
        { rows: 2 }),
      txt('best_contact_time',
        'Best time of day / week to reach you',
        { placeholder: 'e.g. "Weekdays 9–2", "Anytime"' }),

      blockSection('Signature'),
      blockParagraph(MCH_ESIG_CONSENT, 'note'),
      txt('parent_signature',
        'Parent / Guardian — type your full legal name to sign',
        { required: true, prefill: 'parent.full_name' }),
      dateF('signature_date',
        'Date signed',
        { required: true, prefill: 'today' }),
    ],
    notify_emails: [MCH_NOTIFY_EMAIL],
  };
}

// ── Form list ─────────────────────────────────────────────────────
const FORMS = [
  emergencyContactForm(),
  act90Form(),
  dhsAgreementForm(),
  dhsAgreementSummerForm(),
  childHealthReportForm(),
  dentalExamForm(),
  medicationLogForm(),
  parentHandbookAckForm(),
  pressReleaseForm(),
  pottyTrainingAckForm(),
  holidayQuestionnaireForm(),
  volunteerOpportunitiesForm(),
];

// ── Upsert ─────────────────────────────────────────────────────────
async function main() {
  console.log(`Seeding ${FORMS.length} parent-portal forms for Media Children's House`);
  console.log(`Notify email default: ${MCH_NOTIFY_EMAIL} (MCH can edit per-form via the form editor)\n`);
  let created = 0, updated = 0, gated = 0;

  for (const f of FORMS) {
    const existing = await pool.query(
      `SELECT id, needs_review FROM portal_form_definitions
        WHERE school_id = $1 AND slug = $2`,
      [MCH_SCHOOL_ID, f.slug],
    );

    // Per-student visibility rule (migration 048). Always passed, even
    // when null — the column accepts NULL and that's the "applies to
    // every student" sentinel. Lets us un-restrict a form on a re-seed
    // by removing the applies_to property from the form definition.
    const appliesTo = f.applies_to ? JSON.stringify(f.applies_to) : null;

    if (existing.rowCount === 0) {
      await pool.query(
        `INSERT INTO portal_form_definitions
           (school_id, slug, display_name, description, category, per_student,
            is_active, needs_review, allow_addendum, resubmission_allowed,
            one_submission_per_year,
            field_schema, ghl_writeback, notify_emails, webhook_urls,
            confirmation_message, audience, applies_to)
         VALUES ($1,$2,$3,$4,$5,$6, true, false, false, true, false,
                 $7::jsonb, '[]'::jsonb, $8::text[], '{}'::text[], $9, 'parents',
                 $10::jsonb)`,
        [MCH_SCHOOL_ID, f.slug, f.display_name, f.description, f.category, f.per_student,
         JSON.stringify(f.field_schema), f.notify_emails, f.confirmation_message,
         appliesTo],
      );
      console.log(`  ✓ created ${f.slug}`);
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
              -- COALESCE: only overwrite applies_to from code when the
              -- form object DECLARES a rule. Forms with data-driven
              -- rules set out-of-band (e.g. the Child Health Report's
              -- hand-picked student_ids allowlist) have no applies_to
              -- in code, so $10 is NULL and the existing DB rule is
              -- preserved across re-seeds.
              applies_to = COALESCE($10::jsonb, applies_to),
              needs_review = false,
              -- Do NOT force is_active=true on re-seed: an admin may have
              -- deactivated a form out-of-band (e.g. the Summer-Camp DHS
              -- form, which MCH wants off). Re-seeding refreshes content
              -- but must respect that choice. (INSERT still activates.)
              updated_at = now()
        WHERE school_id = $1 AND slug = $2`,
      [MCH_SCHOOL_ID, f.slug, f.display_name, f.description, f.category, f.per_student,
       JSON.stringify(f.field_schema), f.notify_emails, f.confirmation_message,
       appliesTo],
    );
    console.log(`  ↻ updated ${f.slug}`);
    updated++;
  }

  console.log(`\nDone. ${created} created, ${updated} updated, ${gated} skipped.`);
  console.log(`\nNext step: provision the submissions inbox dashboard with`);
  console.log(`  node scripts/provision-dg-portal-forms-dashboard.mjs --school-id ${MCH_SCHOOL_ID}`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => pool.end());

function parseArgs(argv) {
  return { refresh: argv.includes('--refresh') };
}
