// Seed DGM's 3 staff-facing request forms:
//   - Labor Request
//   - Incident / Accident Report
//   - In-house Supplies Request
//
// All three are audience='staff' so they show up on the teacher's
// classroom hub (not the parent portal). All three have Lexi's email
// in notify_emails so she gets pinged on every submission.
//
// Field schemas are best-effort: the Smartsheet labor form + the
// AZDHS-style incident form aren't publicly fetchable. Built from
// the standard DGM patterns + the in-house-supplies dropdown we did
// extract. DGM can edit any field via the form editor.
//
// Re-runnable. By default skips forms with needs_review=false (i.e.
// curated already). Pass --refresh to force-overwrite.

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
const DGM_SCHOOL_ID = 'cfa9030d-c8fe-49ae-a9e7-f1003844ec07';

// Lexi handles all three. DGM staff: update this to the real address
// (best guess based on DGM's pattern). The form editor's "Notify
// these office emails" field is the canonical source — this seed
// just provides a sensible default.
const LEXI_EMAIL = 'lexi@desertgardenmontessori.org';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const ALL_CLASSROOMS = [
  'Infant', 'Early Toddler CR3', 'Toddler CR5', 'Toddler CR6',
  'Primary CR1', 'Primary CR2', 'Primary CR7', 'Primary CR8',
  'LE CR11', 'LE CR12', 'UE CR10', 'UE Tower',
  'MYHS Suite 100', 'Multipurpose CR9',
  'Admin', 'iTeam', 'Kitchen', 'ODE',
];

// ── helpers ────────────────────────────────────────────────────────
const keyify = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);

const blockHeader = (text) => ({ type: 'header', text });
const blockSection = (label, description = null) =>
  description ? { type: 'section', label, description } : { type: 'section', label };
const blockParagraph = (text, emphasis) =>
  emphasis ? { type: 'paragraph', text, emphasis } : { type: 'paragraph', text };
const txt = (key, label, opts = {}) => ({ type: 'text', key, label, ...opts });
const area = (key, label, opts = {}) => ({ type: 'textarea', key, label, rows: 3, ...opts });
const tel = (key, label, opts = {}) => ({ type: 'tel', key, label, ...opts });
const dateF = (key, label, opts = {}) => ({ type: 'date', key, label, ...opts });
const numF = (key, label, opts = {}) => ({ type: 'number', key, label, ...opts });
const fileF = (key, label, opts = {}) => ({ type: 'file_upload', key, label, max_size_mb: 10, ...opts });
const radioF = (key, label, options, opts = {}) => ({
  type: 'radio', key, label,
  options: options.map((v) => typeof v === 'string' ? { value: keyify(v), label: v } : v),
  ...opts,
});
const selectF = (key, label, options, opts = {}) => ({
  type: 'select', key, label,
  options: options.map((v) => typeof v === 'string' ? { value: keyify(v), label: v } : v),
  ...opts,
});
const multi = (key, label, options, opts = {}) => ({
  type: 'multi_checkbox', key, label,
  options: options.map((v) => typeof v === 'string' ? { value: keyify(v), label: v } : v),
  ...opts,
});

// ── Form 1: Labor Request ───────────────────────────────────────────
function laborRequestForm() {
  return {
    slug: 'staff-labor-request',
    display_name: 'Labor Request',
    description: 'Request a maintenance / repair / setup task. Lexi reviews, assigns a scheduled date, and you\'ll see the status update right here once it\'s on the calendar.',
    category: 'staff_request',
    audience: 'staff',
    per_student: false,
    confirmation_message: 'Thanks! Your labor request was submitted. Lexi will review and schedule a date — you\'ll see the status update on your classroom hub once it\'s scheduled.',
    field_schema: [
      blockHeader('Labor Request'),
      blockParagraph(
        'Use this for maintenance, repairs, setup help, room rearrangements, anything that needs Lexi or the facilities team. ' +
        'You\'ll get a scheduled date back once Lexi has put it on the calendar.',
        'note',
      ),
      selectF('classroom_or_location', 'Classroom / location', ALL_CLASSROOMS, { required: true }),
      radioF('request_type', 'Type of request',
        ['Maintenance / repair', 'Setup / move furniture', 'Cleaning (deep clean)', 'Tech / AV help', 'Other'],
        { required: true }),
      radioF('urgency', 'Urgency',
        ['Routine (within 2 weeks)', 'This week', 'ASAP — blocking my class'],
        { required: true }),
      area('description', 'Describe what you need', {
        required: true,
        help: 'Be specific — what\'s broken / what needs to move / what you need built, plus any constraints on timing.',
      }),
      dateF('preferred_date', 'Preferred completion date (optional)',
        { required: false, help: 'Lexi will work with you if the date doesn\'t fit the schedule.' }),
      tel('reachable_at', 'Best number to reach you', { required: false }),
    ],
    notify_emails: [LEXI_EMAIL],
  };
}

// ── Form 2: Incident / Accident Report ──────────────────────────────
function incidentReportForm() {
  return {
    slug: 'staff-incident-report',
    display_name: 'Incident / Accident Report',
    description: 'Report any student injury or incident. Submitted to Lexi immediately. Required for any visible mark, bump, scrape, or behavioral incident that needs documenting.',
    category: 'staff_request',
    audience: 'staff',
    per_student: false,
    confirmation_message: 'Thanks. The incident has been logged and Lexi has been notified. If this is an emergency, also call the front desk now.',
    field_schema: [
      blockHeader('Incident / Accident Report'),
      blockParagraph(
        'Document any injury or incident as soon as it happens. Lexi gets an email instantly. ' +
        'If this is an emergency call the front desk first — this report is for the record.',
        'warning',
      ),

      blockSection('Student & timing'),
      txt('student_name', 'Student first & last name', { required: true }),
      selectF('classroom', 'Classroom', ALL_CLASSROOMS, { required: true }),
      dateF('incident_date', 'Date of incident', { required: true }),
      txt('incident_time', 'Time of incident', { required: true,
        help: 'e.g. "2:35pm" — use a 12- or 24-hour clock; whatever\'s fastest.' }),
      selectF('location', 'Location of incident',
        ['Classroom', 'Playground', 'Bathroom', 'Hallway', 'Cafeteria / kitchen', 'Field / outdoor', 'Field trip', 'Other'],
        { required: true }),

      blockSection('What happened'),
      area('incident_description', 'Describe what happened',
        { required: true, help: 'Use the student\'s words where possible. Include what they were doing, what caused the incident, and the sequence of events.' }),
      area('witnesses', 'Witnesses (staff and/or other students present)',
        { required: false }),

      blockSection('Injury / outcome'),
      radioF('injury_type', 'Type of injury',
        ['No injury — behavioral incident only', 'Scrape / abrasion', 'Bump / bruise', 'Cut (no stitches needed)', 'Cut (may need stitches)', 'Possible sprain / break', 'Head injury', 'Tooth / mouth', 'Other (describe below)'],
        { required: true }),
      area('injury_details', 'Injury details / body part affected',
        { required: false,
          help: 'Required if injury_type is "Other". Describe location on body, severity, what you observed.' }),
      multi('first_aid_given', 'First aid administered (check all that apply)',
        ['Ice pack', 'Bandage', 'Antiseptic', 'Pressure / rest', 'Comforted, no first aid needed', 'EpiPen', 'Inhaler', 'Other (describe below)'],
        { required: false }),
      area('first_aid_details', 'First aid notes', { required: false }),
      radioF('medical_attention_needed', 'Was outside medical attention needed?',
        ['No', 'Yes — parent took student', 'Yes — 911 called', 'Yes — sent to nurse / referred to ER'],
        { required: true }),

      blockSection('Notifications'),
      radioF('parent_notified', 'Has the parent been notified?',
        ['Yes — by me', 'Yes — by front desk', 'No, not yet', 'No, will be at pickup'],
        { required: true }),
      txt('parent_notification_method', 'How was the parent notified?',
        { required: false, help: 'Phone / email / in person / text' }),
      dateF('parent_notified_at_date', 'Date parent was notified', { required: false }),

      blockSection('Reporter'),
      area('follow_up_needed', 'Follow-up needed (optional)',
        { required: false, help: 'Anything that needs to happen next: medical follow-up, parent conference, environmental fix, behavior plan, etc.' }),
    ],
    notify_emails: [LEXI_EMAIL],
  };
}

// ── Form 3: In-house Supplies Request ───────────────────────────────
// Field structure provided by DGM verbatim — 3 quantity grids (item
// rows × quantities 1-5) per category. Item lists below were deduped
// from the source (had near-duplicates with case variations like
// "10 Gal Trash Bag" vs "10 Gal Trash bag").
function suppliesRequestForm() {
  const cleaningItems = [
    '10 Gal Trash Bag',
    '13 Gal Trash Bag w/Tie',
    '33 Gal Trash Bag',
    '55 Gal Black Trash Bag',
    'Tri-fold Paper Towels',
    'Paper Towel Roll (max 2)',
    'Empty Spray Bottle',
    'Laundry Bags',
    'Bleach',
    'Vinegar',
    'Windex',
    'Comet',
    'Clorox Wipes',
    'Clorox Toilet Cleaner',
    'Electronic Cleaning Wipes',
    'Magic Erasers',
    'Blue Sponges',
    'Scotch Brite',
    'White Rags',
    'Broom',
    'Mop Replacement Pads',
    'Counter Hand Soap',
    'Pink Cranberry Soap — Wall Refill',
    'Purple/Clear Lavender Soap — Wall Refill',
    'Dish Soap',
    'Dishwashing Purple Rubber Gloves',
    'Food Prep Gloves',
    'Laundry Detergent',
    'Dryer Sheets',
    'Rectangular Tissues',
    'Toilet Paper (with core — MYHS, 201 & 200)',
    'Toilet Paper (no core)',
    'Covers for Ear Thermometer',
  ];

  const classroomItems = [
    // Office basics
    'Black Pens', 'Blue Pens', 'Red Pens',
    'Pencils', 'Pink Highlighter',
    'Post-Its',
    'Paper Clips', 'Binder Clips Medium', 'Large Binder Clips',
    'Rubber Bands',
    'Staples',
    'Scotch Tape',
    'Sheet Protectors',
    'Printer Paper 8.5x11',
    'Printer Paper 11x17',
    'White Card Stock',
    'Construction Paper',
    'Adult Scissors',
    'Kid Scissors',
    'Liquid Glue',
    'Glue Sticks',
    'Markers',
    'Colored Pencils',
    'Crayons',
    'Brother P-touch Label Tape — black print / white',
    // Expo markers
    'Expo Markers — Black',
    'Expo Markers — Green',
    'Expo Markers — Red',
    'Thin Expo Markers — Black',
    'Thin Expo Markers — Blue',
    'Thin Expo Markers — Green',
    'Thin Expo Markers — Red',
    'Dry Erase Cleaner',
    // Sharpies
    'Sharpie Black',
    'Sharpie Black Extra Fine',
    'Sharpie Blue',
    'Sharpie Blue Extra Fine',
    'Sharpie Red',
    'Sharpie Red Extra Fine',
    // Batteries
    'AA Batteries',
    'AAA Batteries',
    'C Batteries',
    'D Batteries',
    // Classroom / kitchen
    'Napkins', 'Beverage Napkins', 'Tri-Fold Napkins',
    'Metal Bowl',
    'Metal Snack / Toddler Plate',
    'Compost Bags',
    'Laundry Bag',
    'Bandaids',
    'Ice Packs',
    'Cabinet Child Lock',
    'Outlet Covers',
    // DGM-specific
    'DGM Nap Bags',
    'Nap Bag Tags',
    'Laminating Sheets',
  ];

  const diaperItems = [
    'Diapers Size 3',
    'Diapers Size 4',
    'Diapers Size 5',
    'Diapers Size 6',
    'Wipes',
    'Diaper Changing Gloves',
  ];

  const quantityGrid = (key, label, rows, opts = {}) => ({
    type: 'quantity_grid',
    key,
    label,
    rows,
    columns: [1, 2, 3, 4, 5],
    help: 'Pick a quantity for each item you need. Leave items you don\'t need on "—".',
    ...opts,
  });

  return {
    slug: 'staff-supply-request',
    display_name: 'In-House Supplies Request',
    description:
      'Request weekly classroom supplies (Cleaning, Classroom, Diapers/Wipes). ' +
      'If an item isn\'t on this list it requires a Purchase Request — email Lexi instead.',
    category: 'staff_request',
    audience: 'staff',
    per_student: false,
    confirmation_message:
      'Thanks! Your bin will be ready for pick-up Friday morning between 7 AM and 12 PM from the resource room. ' +
      'Please assign someone to pick up your bin and return it by end of day.',
    field_schema: [
      blockHeader('In-House Supplies Request'),
      blockParagraph('This form is to request weekly classroom supplies.'),
      blockParagraph(
        'Timeline:\n' +
        '• Tuesday by end of day — Teachers submit this form with everything needed for the next week.\n' +
        '• Wednesday — Director of Operations orders anything that needs to be replenished.\n' +
        '• Friday morning (7 AM – 12 PM) — Classroom bins ready for pick-up in the resource room. Please assign someone to pick up and return the bin by end of day.',
        'note',
      ),
      blockParagraph(
        'If an item is NOT on this list it requires a Purchase Request — email Lexi directly.',
        'warning',
      ),

      txt('staff_name', 'Name of staff filling out form', { required: false }),
      selectF('classroom', 'Select your classroom', ALL_CLASSROOMS, { required: true }),

      blockSection('Cleaning Supplies',
        'Pick a quantity for each cleaning item you need this week.'),
      quantityGrid('cleaning_supplies', 'Cleaning Supplies', cleaningItems),

      blockSection('Classroom Supplies',
        'Pick a quantity for each classroom item you need this week.'),
      quantityGrid('classroom_supplies', 'Classroom Supplies', classroomItems),

      blockSection('Diapers & Wipes',
        'For Infant / Toddler / Primary classrooms.'),
      quantityGrid('diapers_wipes', 'Diapers / Wipes', diaperItems),

      blockSection('Anything else?'),
      area('notes',
        'Notes for Lexi (optional)',
        { required: false, help: 'Anything that doesn\'t fit the grids above — special timing, allergies, broken bin, etc.' }),
    ],
    notify_emails: [LEXI_EMAIL],
  };
}

const FORMS = [laborRequestForm(), incidentReportForm(), suppliesRequestForm()];

// ── upsert ─────────────────────────────────────────────────────────
async function main() {
  console.log(`Seeding ${FORMS.length} staff request forms for DGM (Lexi: ${LEXI_EMAIL})\n`);
  let created = 0, updated = 0, gated = 0;

  for (const f of FORMS) {
    const existing = await pool.query(
      `SELECT id, needs_review FROM portal_form_definitions
        WHERE school_id = $1 AND slug = $2`,
      [DGM_SCHOOL_ID, f.slug],
    );

    if (existing.rowCount === 0) {
      await pool.query(
        `INSERT INTO portal_form_definitions
           (school_id, slug, display_name, description, category, per_student,
            is_active, needs_review, allow_addendum, resubmission_allowed,
            one_submission_per_year,
            field_schema, ghl_writeback, notify_emails, webhook_urls,
            confirmation_message, audience)
         VALUES ($1,$2,$3,$4,$5,$6, true, false, false, true, false,
                 $7::jsonb, '[]'::jsonb, $8::text[], '{}'::text[], $9, $10)`,
        [DGM_SCHOOL_ID, f.slug, f.display_name, f.description, f.category, f.per_student,
         JSON.stringify(f.field_schema), f.notify_emails, f.confirmation_message, f.audience],
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
              confirmation_message = $9, audience = $10,
              needs_review = false, is_active = true,
              updated_at = now()
        WHERE school_id = $1 AND slug = $2`,
      [DGM_SCHOOL_ID, f.slug, f.display_name, f.description, f.category, f.per_student,
       JSON.stringify(f.field_schema), f.notify_emails, f.confirmation_message, f.audience],
    );
    console.log(`  ↻ updated ${f.slug}`);
    updated++;
  }

  console.log(`\nDone. ${created} created, ${updated} updated, ${gated} skipped.`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => pool.end());

function parseArgs(argv) {
  return { refresh: argv.includes('--refresh') };
}
