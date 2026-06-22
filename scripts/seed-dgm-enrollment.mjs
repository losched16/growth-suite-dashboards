// Seeds Desert Garden Montessori's Enrollment Agreement 2026-27 form.
//
// Mirrors the PDF Leslie sent over: Family Info → Tuition & Fees →
// Financial T&Cs → Acknowledgments → Signature.
//
// Field counts ~50 across all sections. Once DGM has the admin form
// editor (Phase 5), they'll be able to edit any of this in place.
// Until then, this seed is the source of truth.
//
// Run:
//   SCHOOL_ID=cfa9030d-c8fe-49ae-a9e7-f1003844ec07 \
//     node scripts/seed-dgm-enrollment.mjs

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

const SCHOOL_ID = process.env.SCHOOL_ID || 'cfa9030d-c8fe-49ae-a9e7-f1003844ec07';
const SLUG = 'dgm-enrollment-agreement-2026-27';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ─── Reusable text blocks ──────────────────────────────────────────────

const ANNUAL_COMMITMENT_TEXT =
  'DGM REQUIRES AN ANNUAL TUITION COMMITMENT FOR THE ENTIRE 10-MONTH ACADEMIC SCHOOL YEAR, ' +
  'REGARDLESS OF ATTENDANCE. When you sign this Enrollment Agreement you are agreeing to pay ' +
  'tuition for the entire 10-month academic school year (or for the entire month during which ' +
  'your child starts school late and for all months remaining in the 10-month academic school ' +
  'year), even if you withdraw your child, and even if you do so before school starts. ' +
  'There is no grace period after signing.\n\n' +
  'DGM enforces the Annual Tuition Commitment without exception unless: (1) you withdraw your ' +
  'child based on DGM\'s recommendation that the school cannot meet your child\'s specific needs; ' +
  'or (2) you provide 30 days written notice that you intend to voluntarily withdraw your child ' +
  'and to cancel this Enrollment Agreement, AND you pay in full a $2,000 Withdrawal Fee at the ' +
  'time you submit the required written notice. You will remain responsible to pay tuition for ' +
  'the final full month during which your 30-day written notice period ends.';

const ENROLLMENT_FEE_TEXT =
  'There is a $395 non-refundable Enrollment Fee for each student who is enrolled on or before ' +
  'January 31, 2026. For students enrolled on or after February 1, 2026, there is a $595 ' +
  'non-refundable Enrollment Fee. The Enrollment Fee is due in full upon enrollment and before ' +
  'the student\'s start date. No extensions or payment plans are permitted, and the Enrollment ' +
  'Fee is not pro-rated for late enrollees.';

// Dropdown option lists (Leslie's "Live Form" values from the Rediker
// screenshot for LDMA, and a reasonable mirror for Physical Custody).
const PHYSICAL_CUSTODY_OPTIONS = [
  { value: 'pg1_sole',        label: 'Parent/Guardian 1 has sole physical custody' },
  { value: 'pg2_sole',        label: 'Parent/Guardian 2 has sole physical custody' },
  { value: 'joint_married',   label: 'Parents/Guardians share joint physical custody (married)' },
  { value: 'joint_unmarried', label: 'Parents/Guardians share joint physical custody (unmarried)' },
  { value: 'joint_divorced',  label: 'Parents/Guardians share joint physical custody (divorced)' },
  { value: 'other',           label: 'Other' },
];

const LDMA_OPTIONS = [
  { value: 'pg1_sole',        label: 'Parent/Guardian 1 has sole LDMA' },
  { value: 'pg2_sole',        label: 'Parent/Guardian 2 has sole LDMA' },
  { value: 'joint_married',   label: 'Parents/Guardians share joint LDMA (married)' },
  { value: 'joint_unmarried', label: 'Parents/Guardians share joint LDMA (unmarried)' },
  { value: 'joint_divorced',  label: 'Parents/Guardians share joint LDMA (divorced)' },
  { value: 'other',           label: 'Other' },
];

const GRADE_OPTIONS = [
  { value: 'infant',           label: 'Infant (6 weeks – 12 months)' },
  { value: 'toddler',          label: 'Toddler (12 months – 3 years)' },
  { value: 'primary',          label: 'Primary (3 – 6 years)' },
  { value: 'lower_elementary', label: 'Lower Elementary (6 – 9 years)' },
  { value: 'upper_elementary', label: 'Upper Elementary (9 – 12 years)' },
  { value: 'middle_years',     label: 'Middle Years (12 – 16 years)' },
  { value: 'high_school',      label: 'High School (16 – 18 years)' },
];

const ETHNICITY_OPTIONS = [
  { value: 'american_indian',  label: 'American Indian or Alaska Native' },
  { value: 'asian',            label: 'Asian' },
  { value: 'black',            label: 'Black or African American' },
  { value: 'hispanic',         label: 'Hispanic or Latino' },
  { value: 'pacific_islander', label: 'Native Hawaiian or Other Pacific Islander' },
  { value: 'white',            label: 'White' },
  { value: 'two_or_more',      label: 'Two or more races' },
  { value: 'prefer_not_say',   label: 'Prefer not to say' },
];

const STATE_OPTIONS = [
  { value: 'AZ', label: 'Arizona' }, { value: 'CA', label: 'California' },
  { value: 'CO', label: 'Colorado' }, { value: 'NV', label: 'Nevada' },
  { value: 'NM', label: 'New Mexico' }, { value: 'TX', label: 'Texas' },
  { value: 'UT', label: 'Utah' }, { value: 'other', label: 'Other (US)' },
];

// ─── Field schema ──────────────────────────────────────────────────────

const FIELD_SCHEMA = [
  // ============================================================
  // SECTION 1 — Family Info
  // ============================================================
  { type: 'header', text: 'Enrollment Agreement 2026-27' },
  { type: 'paragraph', emphasis: 'warning', text: ANNUAL_COMMITMENT_TEXT },

  { type: 'section', label: 'Student Information' },
  { type: 'date',   key: 'birth_date',            label: 'Birth date',                            required: true, prefill: 'student.date_of_birth' },
  { type: 'date',   key: 'enrollment_start_date', label: 'Enrollment start date',                  required: true,
    help: 'Pre-filled by the admissions team. If incorrect, please contact support@desertgardenmontessori.org.' },
  { type: 'select', key: 'grade_level',           label: '2026-27 grade level',                    required: true, options: GRADE_OPTIONS },
  { type: 'select', key: 'ethnicity',             label: 'Ethnicity',                              required: true, options: ETHNICITY_OPTIONS },

  // ── Parent/Guardian 1 ──────────────────────────────────────
  { type: 'section', label: 'Parent / Guardian 1',
    description: 'If you have a second parent/guardian who should be on the enrollment record, you can add them at the bottom of this section.' },
  { type: 'text',  key: 'pg1_first_name',  label: 'First name',          required: true, prefill: 'parent.first_name' },
  { type: 'text',  key: 'pg1_last_name',   label: 'Last name',           required: true, prefill: 'parent.last_name' },
  { type: 'text',  key: 'pg1_street',      label: 'Street address',      required: true },
  { type: 'text',  key: 'pg1_city',        label: 'City',                required: true },
  { type: 'select',key: 'pg1_state',       label: 'State',               required: true, options: STATE_OPTIONS },
  { type: 'text',  key: 'pg1_zip',         label: 'ZIP',                 required: true, max_length: 10 },
  { type: 'tel',   key: 'pg1_home_phone',  label: 'Home phone' },
  { type: 'tel',   key: 'pg1_mobile_phone',label: 'Mobile phone',        required: true, prefill: 'parent.phone' },
  { type: 'tel',   key: 'pg1_office_phone',label: 'Office phone' },
  { type: 'email', key: 'pg1_home_email',  label: 'Home email',          required: true, prefill: 'parent.email' },
  { type: 'email', key: 'pg1_office_email',label: 'Office email' },
  { type: 'text',  key: 'pg1_employer',    label: "Employer's name",     required: true },
  { type: 'text',  key: 'pg1_position',    label: 'Position / title',    required: true },

  // ── Parent/Guardian 2 (opt-in) ─────────────────────────────
  { type: 'section', label: 'Parent / Guardian 2 — optional',
    description: 'Only complete this section if a second parent/guardian should be on the enrollment record.' },
  { type: 'checkbox', key: 'pg2_present',    label: 'I want to add a second parent/guardian' },
  { type: 'text',  key: 'pg2_first_name',  label: "P/G 2 — first name" },
  { type: 'text',  key: 'pg2_last_name',   label: "P/G 2 — last name" },
  { type: 'text',  key: 'pg2_street',      label: "P/G 2 — street address",
    help: 'Leave blank if same as Parent/Guardian 1.' },
  { type: 'text',  key: 'pg2_city',        label: 'P/G 2 — city' },
  { type: 'select',key: 'pg2_state',       label: 'P/G 2 — state',       options: STATE_OPTIONS },
  { type: 'text',  key: 'pg2_zip',         label: 'P/G 2 — ZIP',         max_length: 10 },
  { type: 'tel',   key: 'pg2_mobile_phone',label: 'P/G 2 — mobile phone' },
  { type: 'email', key: 'pg2_home_email',  label: 'P/G 2 — email' },
  { type: 'text',  key: 'pg2_employer',    label: "P/G 2 — employer" },
  { type: 'text',  key: 'pg2_position',    label: 'P/G 2 — position / title' },

  // ── Physical Custody ──────────────────────────────────────
  { type: 'section', label: 'Physical Custody' },
  { type: 'select', key: 'physical_custody',       label: 'Who does the child live with?', required: true, options: PHYSICAL_CUSTODY_OPTIONS },
  { type: 'text',   key: 'physical_custody_other', label: 'If Other, please state name and relationship to the child' },

  // ── LDMA ───────────────────────────────────────────────────
  { type: 'section', label: 'Legal Decision-Making Authority (LDMA)' },
  { type: 'select', key: 'ldma',                   label: 'Who has Legal Decision-Making Authority?', required: true, options: LDMA_OPTIONS },
  { type: 'text',   key: 'ldma_other',             label: 'If Other, please state name and relationship to the child' },
  { type: 'paragraph', emphasis: 'note',
    text: 'If applicable, please upload documentation regarding Physical Custody and Legal Decision-Making Authority below.' },
  { type: 'file_upload', key: 'custody_documents',
    label: 'Custody / LDMA documentation (optional)',
    accept: '.pdf,.jpg,.jpeg,.png',
    multiple: true,
    max_size_mb: 10 },

  // ============================================================
  // SECTION 2 — Tuition & Fees
  // ============================================================
  { type: 'section', label: 'Tuition & Fees' },
  { type: 'paragraph',
    text: 'Tuition is based on the program / grade level you selected above. Tuition will be prorated monthly (not weekly or daily) for students who start school after classes begin. Tuition is billed for the entire month during which your child starts school, regardless of the start date.' },

  // PROGRAM TUITION — pricing_select with all options.
  // (Grade-filter logic comes in Phase 2 — the renderer hides options
  // that don't match the selected grade. For now, parent picks the
  // matching option for their child's grade.)
  { type: 'pricing_select',
    key: 'program_tuition',
    label: 'Program tuition (annual)',
    required: true,
    show_price_in_label: true,
    help: 'Options shown match the grade level you selected above. Tuition will be prorated monthly for late starters.',
    options: [
      // Each option only appears when the selected grade_level matches.
      { value: 'infant_school',      label: 'Infant — School Day (8:30am – 2:30pm)',                   amount_cents: 1950000,
        visible_when: { field: 'grade_level', equals: ['infant'] } },
      { value: 'tp_half',            label: 'Toddler / Primary — Half Day (8:30am – 12:00pm)',         amount_cents: 1300000,
        visible_when: { field: 'grade_level', equals: ['toddler', 'primary'] } },
      { value: 'tp_school',          label: 'Toddler / Primary — School Day (8:30am – 2:30pm)',        amount_cents: 1625000,
        visible_when: { field: 'grade_level', equals: ['toddler', 'primary'] } },
      { value: 'lower_elem_school',  label: 'Lower Elementary — School Day (8:00am – 3:15pm)',         amount_cents: 1400000,
        visible_when: { field: 'grade_level', equals: ['lower_elementary'] } },
      { value: 'upper_elem_school',  label: 'Upper Elementary — School Day (8:00am – 3:30pm)',         amount_cents: 1400000,
        visible_when: { field: 'grade_level', equals: ['upper_elementary'] } },
      { value: 'middle_high_school', label: 'Middle Years / High School — School Day (8:00am – 3:30pm)', amount_cents: 1730000,
        visible_when: { field: 'grade_level', equals: ['middle_years', 'high_school'] } },
    ],
  },

  // EXTENDED DAY
  { type: 'paragraph',
    text: 'Extended Day care/supervision is available until the school closes (usually 6:00 p.m.). Billed for the entire 10-month academic school year at $4,950 ($495/month), prorated monthly. There is a $100 cancellation fee. The cost of Childcare Days is included for those enrolled in Extended Day.' },
  { type: 'pricing_select',
    key: 'extended_day',
    label: 'Extended Day',
    required: true,
    show_price_in_label: true,
    // Extended Day isn't offered for the half-day program — hide the whole
    // field when Toddler/Primary Half Day is selected. Shows for every
    // full-day program.
    visible_when: { field: 'program_tuition', equals: ['infant_school', 'tp_school', 'lower_elem_school', 'upper_elem_school', 'middle_high_school'] },
    options: [
      { value: 'enroll',  label: 'Enroll in Extended Day (until 6:00 p.m.)', amount_cents: 495000 },
      { value: 'decline', label: 'Decline Extended Day',                     amount_cents: 0      },
    ],
  },

  // ORGANIC LUNCH
  { type: 'paragraph',
    text: 'DGM offers Organic Lunch to all students. Billed annually at $2,100 ($210/month), prorated monthly. The cost of Organic Lunch is included in tuition for Infant/Toddler/Primary Programs. There is no cancellation fee, but there is a $100 fee if you later re-enroll.' },
  { type: 'pricing_select',
    key: 'organic_lunch',
    label: 'Organic Lunch',
    required: true,
    // Price is embedded in the paid labels, so don't also append it.
    show_price_in_label: false,
    options: [
      // Decline only for Elementary/MYHS (paid opt-in). Infant/Toddler/Primary
      // get lunch free and MUST pick a diet, so decline is hidden for them.
      { value: 'decline',                     label: 'I decline Organic Lunch',                              amount_cents: 0,      visible_when: { field: 'program_tuition', equals: ['lower_elem_school', 'upper_elem_school', 'middle_high_school'] } },
      // Infant / Toddler / Primary — included free; one row per diet.
      { value: 'included_nonvegetarian',      label: 'Included (Infant/Toddler/Primary) - Nonvegetarian',   amount_cents: 0,      visible_when: { field: 'program_tuition', equals: ['infant_school', 'tp_half', 'tp_school'] } },
      { value: 'included_vegan',              label: 'Included (Infant/Toddler/Primary) - Vegan',           amount_cents: 0,      visible_when: { field: 'program_tuition', equals: ['infant_school', 'tp_half', 'tp_school'] } },
      { value: 'included_vegetarian',         label: 'Included (Infant/Toddler/Primary) - Vegetarian',      amount_cents: 0,      visible_when: { field: 'program_tuition', equals: ['infant_school', 'tp_half', 'tp_school'] } },
      // Elementary / MYHS — $2,100/year; one row per diet.
      { value: 'organic_2100_nonvegetarian',  label: 'Organic Lunch $2,100 - Nonvegetarian',                amount_cents: 210000, visible_when: { field: 'program_tuition', equals: ['lower_elem_school', 'upper_elem_school', 'middle_high_school'] } },
      { value: 'organic_2100_vegan',          label: 'Organic Lunch $2,100 - Vegan',                        amount_cents: 210000, visible_when: { field: 'program_tuition', equals: ['lower_elem_school', 'upper_elem_school', 'middle_high_school'] } },
      { value: 'organic_2100_vegetarian',     label: 'Organic Lunch $2,100 - Vegetarian',                   amount_cents: 210000, visible_when: { field: 'program_tuition', equals: ['lower_elem_school', 'upper_elem_school', 'middle_high_school'] } },
    ],
  },

  // DISCOUNTS / CREDITS
  { type: 'section', label: 'Discounts & Credits' },
  { type: 'paragraph',
    text: 'Sibling Discount — 10% off Annual Tuition for younger siblings concurrently enrolled. Applied automatically based on your family\'s active students.\n\n' +
          'Annual Discount — 5% off Annual Tuition if paid in full by July 1 (or before your child\'s late start date). Does NOT apply if the Sibling Discount has been applied. Triggered automatically when you choose the Annual Payment Plan below.\n\n' +
          'Referral Credit — Families who refer a new family receive a one-time $500 credit at the end of the referred student\'s first academic school year. Does not affect today\'s total.' },
  { type: 'text', key: 'referral_student',
    label: 'If applicable, name of the currently enrolled student who referred you (optional)' },

  // ENROLLMENT FEE — info-only paragraph; actual fee is added as a
  // payment_config line at submit time, dollar-amount auto-determined
  // by the date the parent signs (Phase 2 makes it dynamic; for now
  // the seeded payment_config charges $595 since the demo is after
  // Feb 1, 2026).
  { type: 'section', label: 'Other Fees' },
  { type: 'paragraph', emphasis: 'warning', text: ENROLLMENT_FEE_TEXT },
  { type: 'paragraph',
    text: 'Athletic, Enrichment, Summer Session, and Student Support Team fees vary and are billed separately when applicable. Discounts do not apply to Student Support Team services.' },

  // ============================================================
  // SECTION 3 — Financial T&Cs + Payment Plan
  // ============================================================
  { type: 'section', label: 'Payment Plan' },
  { type: 'paragraph',
    text: 'Choose how you would like to pay your Annual Tuition. The Enrollment Fee shown below is due upfront and is separate from your tuition payment plan.\n\n' +
          '• Monthly — 10 equal automatic payments on the 1st of each month (Aug due Jul 1, final May due Apr 1). A 3% Administrative Fee applies.\n' +
          '• Semi-Annual — 2 equal automatic payments (Jul 1 and Dec 1). Not available to late enrollees.\n' +
          '• Annual — 1 automatic payment by Jul 1 (or before late start date). Includes a 5% discount on Annual Tuition (does NOT stack with Sibling Discount).' },
  { type: 'radio',
    key: 'payment_plan',
    label: 'Please select your Payment Plan',
    required: true,
    options: [
      { value: 'monthly',     label: 'Monthly (10 payments, +3% Administrative Fee)' },
      { value: 'semi_annual', label: 'Semi-Annual (2 payments)' },
      { value: 'annual',      label: 'Annual (1 payment, 5% discount on tuition)' },
    ],
  },

  // ============================================================
  // SECTION 4 — Acknowledgments
  // ============================================================
  { type: 'section', label: 'Acknowledgments',
    description: 'Please read and confirm each section below before signing.' },

  { type: 'paragraph', emphasis: 'note',
    text: 'Parent Handbook — Parents/Guardians agree and acknowledge that they are responsible for reading, understanding, and complying with the DGM Parent Handbook, which can be found on the school website and is subject to change at the school\'s discretion.' },
  { type: 'checkbox', key: 'ack_handbook',           label: 'I have read and understand the Parent Handbook section.', required: true },

  { type: 'paragraph', emphasis: 'note',
    text: 'Photos / Videos — DGM students may occasionally be photographed and/or video-recorded during school events, classroom instruction, and at other times while on or off campus while participating in school activities and trips. You acknowledge and agree that your child may be photographed and/or video-recorded without prior notice, and that your child\'s image may be used without compensation in the school\'s publications and promotional materials, including those published online. No identifying information will be shared.' },
  { type: 'checkbox', key: 'ack_photos_videos',      label: 'I have read and understand the Photos / Videos section.', required: true },

  { type: 'paragraph', emphasis: 'note',
    text: 'Parking Lot Crossing — The DGM campus consists of two buildings separated by a parking lot. You acknowledge and agree that your child may cross the parking lot, either accompanied by an adult if age-appropriate, or unaccompanied by an adult and with staff permission.' },
  { type: 'checkbox', key: 'ack_parking_lot',        label: 'I have read and understand the Parking Lot Crossing section.', required: true },

  { type: 'paragraph', emphasis: 'note',
    text: 'Force Majeure — DGM\'s obligations may be suspended immediately and without notice when the school is closed due to force majeure events (fire, acts of God, weather/natural disasters, war, governmental action, acts of terrorism, epidemic/pandemic, or any other event beyond the school\'s control). If such an event occurs, no refunds or credits will be issued.' },
  { type: 'checkbox', key: 'ack_force_majeure',      label: 'I have read and understand the Force Majeure section.', required: true },

  { type: 'paragraph', emphasis: 'note',
    text: 'Liquidated Damages — DGM is a nonprofit, private school that budgets scarce resources each year based on enrollment commitments. You acknowledge and agree that withdrawing your child after signing the Enrollment Agreement will cause incalculable damages to the school, even if the school later fills the vacancy, and that payment of the Withdrawal Fee or DGM\'s retention of amounts paid shall be deemed liquidated damages, and not a penalty.' },
  { type: 'checkbox', key: 'ack_liquidated_damages', label: 'I have read and understand the Liquidated Damages section.', required: true },

  { type: 'paragraph', emphasis: 'note',
    text: 'School / Family Cooperation — Positive, collaborative, and constructive relationships are crucial to the school\'s mission. DGM reserves sole discretion to suspend or dismiss students, and to restrict participation/attendance at school events of Parents/Guardians and others who behave or communicate in a disrespectful, disruptive, intimidating, or aggressive manner. Suspension/dismissal/restrictions do not relieve Parents/Guardians from the Annual Tuition Commitment.' },
  { type: 'checkbox', key: 'ack_cooperation',        label: 'I have read and understand the School / Family Cooperation section.', required: true },

  { type: 'paragraph', emphasis: 'note',
    text: 'School Directory — The School Directory and all other personal, private and/or non-public information about students and families are confidential and use is restricted for only school purposes. Parents/Guardians agree to maintain/update accurate information, including current phone numbers and mail/email addresses.' },
  { type: 'checkbox', key: 'ack_directory',          label: 'I have read and understand the School Directory section.', required: true },

  { type: 'paragraph', emphasis: 'note',
    text: 'Emergency Medical Care — If a licensed medical professional opines that your child requires emergency medical treatment that requires Parent/Guardian consent, you acknowledge and agree that the school may give such consent if you are unavailable/unable to do so. You release and hold DGM harmless from all liability that might arise from the school\'s consent to emergency medical treatment, for which you also agree to reimburse the school.' },
  { type: 'checkbox', key: 'ack_emergency_medical',  label: 'I have read and understand the Emergency Medical Care section.', required: true },

  // ── Signature ─────────────────────────────────────────────
  { type: 'section', label: 'Signature' },
  { type: 'paragraph',
    text: 'By signing below, the undersigned parent(s)/guardian(s) agree to enroll the named student at DGM for the 2026-27 academic school year based on the terms and conditions herein. The undersigned acknowledges legal decision-making authority and is solely or jointly and severally liable for complying with the terms and conditions of this Enrollment Agreement and for the financial obligations based on the selections/responses herein.' },
  { type: 'signature_drawn', key: 'parent_signature',      label: 'Sign here',                       required: true },
  { type: 'signature_typed', key: 'parent_signature_typed',label: 'Type your full legal name here',  required: true,
    acknowledgment: 'By typing my name below, I confirm I have read and agree to this Enrollment Agreement in full.' },
  { type: 'date',            key: 'signature_date',        label: 'Date',                            required: true, prefill: 'today' },
];

// ─── payment_config ────────────────────────────────────────────────────
// Phase 1: charge the Enrollment Fee + the selected program tuition +
// Extended Day + Organic Lunch upfront on submit. Phase 2 splits this so
// only the Enrollment Fee is due immediately and the rest is invoiced
// across the chosen Payment Plan.
//
// Phase 1 enrollment fee is hard-coded to $595 (post Feb 1, 2026); Phase
// 2 makes the dollar amount date-aware.

const PAYMENT_CONFIG = {
  mode: 'required',
  invoice_title_template: 'Enrollment Agreement 2026-27 — {student_name}',
  due_days_from_submission: 0,
  // Phase 3 will split this so the Enrollment Fee is due immediately
  // and the tuition + addons go onto the selected Payment Plan as
  // installments. For Phase 2 we charge everything up front in one
  // invoice so the business officer can run end-to-end.
  lines: [
    // Tuition + addons — selected via the form's pricing_select fields,
    // prorated based on the parent's chosen enrollment_start_date.
    // Anchor 2026-08-01 + 10 months → late-October start = 8/10 of annual.
    { kind: 'pricing_select', field_key: 'program_tuition', label_template: '{label}', category: 'tuition',
      prorate: { reference_field: 'enrollment_start_date', anchor_date: '2026-08-01', total_months: 10 } },
    { kind: 'pricing_select', field_key: 'extended_day',    label_template: '{label}', category: 'extended_day',
      prorate: { reference_field: 'enrollment_start_date', anchor_date: '2026-08-01', total_months: 10 } },
    { kind: 'pricing_select', field_key: 'organic_lunch',   label_template: '{label}', category: 'lunch',
      prorate: { reference_field: 'enrollment_start_date', anchor_date: '2026-08-01', total_months: 10 } },
    // Enrollment fee — date-aware: $395 on/before Jan 31, 2026; $595 after.
    {
      kind: 'date_based_fee',
      label_before_cutoff: 'Enrollment Fee (non-refundable, on or before Jan 31, 2026)',
      label_after_cutoff:  'Enrollment Fee (non-refundable, signed after Feb 1, 2026)',
      cutoff_date: '2026-01-31',
      before_cents: 39500,
      after_cents:  59500,
      category: 'enrollment_fee',
    },
    // Payment-plan modifier — Monthly adds +3% admin fee, Annual gets
    // a -5% discount (applies to tuition + addons categories).
    {
      kind: 'payment_plan_modifier',
      field_key: 'payment_plan',
      modifiers: {
        monthly: {
          label: 'Monthly Payment Plan — Administrative Fee (+3%)',
          pct_basis_points: 300,
          applies_to_categories: ['tuition', 'extended_day', 'lunch'],
          category: 'admin_fee',
        },
        annual: {
          label: 'Annual Payment Plan — Discount (−5%)',
          pct_basis_points: -500,
          applies_to_categories: ['tuition', 'extended_day', 'lunch'],
          category: 'plan_discount',
        },
      },
    },
  ],
};

// ─── Seed write ────────────────────────────────────────────────────────

async function main() {
  const c = await pool.connect();
  try {
    await c.query(
      `INSERT INTO portal_form_definitions
         (school_id, slug, display_name, description, category, per_student,
          required_for, field_schema, ghl_writeback, fee_amount,
          one_submission_per_year, resubmission_allowed, needs_review,
          is_active, payment_config, allow_addendum)
       VALUES ($1, $2, $3, $4, 'enrollment', true, 'enrolled', $5::jsonb, '[]'::jsonb,
               NULL, true, true, true, true, $6::jsonb, true)
       ON CONFLICT (school_id, slug) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         description  = EXCLUDED.description,
         field_schema = EXCLUDED.field_schema,
         payment_config = EXCLUDED.payment_config,
         allow_addendum = true,
         needs_review = true,
         is_active = true,
         updated_at   = now()`,
      [
        SCHOOL_ID, SLUG,
        'Enrollment Agreement 2026-27',
        "Desert Garden Montessori's annual enrollment agreement. Covers student info, parent/guardian details, custody, tuition selection, payment plan, and required acknowledgments.",
        JSON.stringify(FIELD_SCHEMA),
        JSON.stringify(PAYMENT_CONFIG),
      ],
    );
    const keyedCount = FIELD_SCHEMA.filter((b) => 'key' in b).length;
    const totalBlocks = FIELD_SCHEMA.length;
    console.log(`✓ Seeded /forms-v2/${SLUG}`);
    console.log(`  ${totalBlocks} total blocks, ${keyedCount} answerable fields`);
    console.log(`  Open at: https://growth-suite-parent-portal.vercel.app/forms-v2/${SLUG}`);
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
