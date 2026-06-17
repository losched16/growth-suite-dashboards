// Seed MCH's Tuition Agreement portal form for the 2026-27 year.
//
// One form, per_student (each kid gets their own contract). Reads the
// new enrollment.* prefill sources so every family sees THEIR
// contracted amount, plan, installment math, and due dates pre-filled
// — no Calculate-Your-Own arithmetic in the contract.
//
// Source: 10 contract templates in mch-forms/Tuition Forms/ — the
// generic legal text is identical across them; only the dollar amounts
// and plan terms vary. By prefilling from family_tuition_enrollments
// we collapse all 10 into one form that surfaces the right numbers per
// family.
//
// Idempotent (upserts on school_id + slug).
//
// Usage:
//   node scripts/seed-mch-tuition-agreement.mjs               # create/refresh
//   node scripts/seed-mch-tuition-agreement.mjs --refresh     # overwrite curated

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
const MCH_NOTIFY_EMAIL = 'mchadmin@mediachildrenshouse.com';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Block helpers (mirror seed-mch-parent-forms.mjs for consistency).
const blockHeader = (text) => ({ type: 'header', text });
const blockSection = (label, description = null) =>
  description ? { type: 'section', label, description } : { type: 'section', label };
const blockParagraph = (text, emphasis) =>
  emphasis ? { type: 'paragraph', text, emphasis } : { type: 'paragraph', text };
const txt = (key, label, opts = {}) => ({ type: 'text', key, label, ...opts });
const dateF = (key, label, opts = {}) => ({ type: 'date', key, label, ...opts });
const timeF = (key, label, opts = {}) => ({ type: 'time', key, label, ...opts });
const numF = (key, label, opts = {}) => ({ type: 'number', key, label, ...opts });
const checkboxF = (key, label, opts = {}) => ({ type: 'checkbox', key, label, ...opts });
const signatureStamp = (signer_name, signer_title, signed_date) =>
  ({ type: 'signature_stamp', signer_name, signer_title, signed_date });

const ESIG_CONSENT =
  'By typing my name below I agree to conduct business with Media Children\'s House by ' +
  'electronic means. I intend by typing my name below to "sign" the preceding document ' +
  'and to be bound by its terms and conditions.';

const form = {
  slug: 'mch-tuition-agreement-2026-27',
  display_name: '2026-2027 Tuition Agreement',
  description:
    'Required tuition contract for the September 2026 – June 2027 school year. ' +
    'Your itemized tuition, fees, payment plan, and attendance schedule are pre-filled below from ' +
    'your enrollment paperwork. Review everything and sign at the bottom.',
  category: 'enrollment',
  per_student: true,
  notify_emails: [MCH_NOTIFY_EMAIL],
  confirmation_message:
    'Thanks! Your signed Tuition Agreement has been received and added to your child\'s ' +
    'file. The office will follow up only if anything needs clarification.',
  field_schema: [
    blockHeader('Tuition Contract 2026–2027'),
    blockParagraph(
      'Media Children\'s House · c/o Victoria Whitby, Director · 3301 Concord Road · Aston, PA 19014',
      'note',
    ),

    blockSection('Your Enrollment',
      'These details come from your enrollment paperwork on file. They are locked — to change anything below, contact the office.'),
    txt('child_name',
      'Child\'s name',
      { required: true, prefill: 'student.full_name', readOnly: true }),
    txt('program',
      'Program & schedule',
      { required: true, prefill: 'enrollment.program_label', readOnly: true,
        help: 'The program & schedule listed on your enrollment paperwork.' }),
    txt('plan',
      'Payment plan',
      { required: true, prefill: 'enrollment.plan_label', readOnly: true }),

    blockSection('Tuition & Fees',
      'Itemized breakdown from your enrollment paperwork. You will be billed exactly the "Total amount due" below, split across the installments shown — nothing more. Credit lines (deposit, discounts, scholarship) are already subtracted from the total.'),
    txt('base_tuition_dollars',
      'Base tuition ($)',
      { required: true, prefill: 'enrollment.base_tuition_dollars', readOnly: true,
        help: 'Annual tuition for your program & schedule.' }),
    txt('extended_care_dollars',
      'Extended care ($)',
      { prefill: 'enrollment.extended_care_dollars', readOnly: true,
        help: 'Annual extended-care fee. Blank if you did not enroll in extended care.' }),
    txt('development_fee_dollars',
      'Development fee ($)',
      { required: true, prefill: 'enrollment.development_fee_dollars', readOnly: true,
        help: 'Non-refundable annual development fee.' }),
    txt('deposit_credit_dollars',
      'Deposit already paid — credit (−$)',
      { prefill: 'enrollment.deposit_dollars', readOnly: true,
        help: 'Your enrollment deposit, credited against this year\'s balance.' }),
    txt('sibling_discount_dollars',
      'Sibling discount — credit (−$)',
      { prefill: 'enrollment.sibling_discount_dollars', readOnly: true,
        help: '10% multi-child discount. Blank if not applicable.' }),
    txt('scholarship_dollars',
      'Scholarship — credit (−$)',
      { prefill: 'enrollment.scholarship_dollars', readOnly: true,
        help: 'Awarded scholarship. Blank if not applicable.' }),
    txt('total_amount_due_dollars',
      'Total amount due for 2026–2027 ($)',
      { required: true, prefill: 'enrollment.total_annual_dollars', readOnly: true,
        help: 'Base tuition + extended care + development fee, less any deposit, discounts, and scholarship above.' }),
    txt('installment_count',
      'Number of installments',
      { required: true, prefill: 'enrollment.installment_count', readOnly: true }),
    txt('installment_dollars',
      'Per-installment amount ($)',
      { required: true, prefill: 'enrollment.installment_dollars', readOnly: true,
        help: 'Total amount due ÷ number of installments.' }),

    blockSection('Days & Hours of Attendance',
      'Your child\'s scheduled days and arrival / departure times, from your enrollment paperwork. Contact the office to change them.'),
    txt('attendance_days',
      'Days of attendance',
      { required: true, prefill: 'enrollment.schedule_days', readOnly: true }),
    txt('arrival_time',
      'Arrival time',
      { required: true, prefill: 'enrollment.arrival_time', readOnly: true }),
    txt('departure_time',
      'Departure time',
      { required: true, prefill: 'enrollment.departure_time', readOnly: true }),

    blockSection('Payment Schedule'),
    blockParagraph(
      'Your payment plan above determines when each installment is due. Payments are due ' +
      'on the 15th of each scheduled month. First payment due:',
    ),
    dateF('first_due_date',
      'First payment due',
      { required: true, prefill: 'enrollment.first_due_date', readOnly: true }),
    dateF('last_due_date',
      'Final payment due',
      { required: true, prefill: 'enrollment.last_due_date', readOnly: true }),
    blockParagraph(
      'Media Children\'s House currently accepts check, cash, money order, and electronic ACH payments ' +
      '(available through the parent portal). A $5.00 ACH convenience fee will be charged per transaction. ' +
      'Checks should be made payable to Media Children\'s House.',
    ),

    blockSection('Standard Terms'),
    blockParagraph(
      'This agreement is between Media Children\'s House, Inc. ("School") and the undersigned ' +
      'parent / guardian ("Undersigned"). The School hereby accepts your child for enrollment in the ' +
      'September 2026 – June 2027 school year.',
    ),
    blockParagraph(
      'It is understood and agreed that all children are accepted on a one-month trial basis, during which ' +
      'time the School reserves the right to withdraw the student. The School will make a pro-rata ' +
      'allowance if the pupil is accepted after the first two weeks of the school year. However, once a ' +
      'child is enrolled and the contract signed, no reduction or credit will be granted by the School ' +
      'unless the student is withdrawn by the specific request of the School, for serious illness ' +
      '(documented by a pediatrician), or due to relocation where one month\'s notice is given.',
    ),
    blockParagraph(
      'Disaster-induced closure (e.g. pandemic): instruction will be moved to an online platform for ' +
      'primary and kindergarten students; no instruction for young community students. If closure lasts ' +
      'more than two weeks, monthly payments are reduced to $0 for young community children. Primary ' +
      'and kindergarten families pay virtual learning rates of $800/wk (5 days) or $600/wk (3 days), ' +
      'prorated upon return to in-person learning.',
    ),
    blockParagraph(
      'Late pickups: $1 per minute after 10 minutes past scheduled pick-up. $35 per occurrence after ' +
      '5:30 PM (closing time), in addition to the regular late pickup fee. Late tuition: $1/day starting ' +
      'after the 5-day grace. Payments more than 30 days past due may result in withdrawal of the child ' +
      'from the program.',
      'warning',
    ),
    blockParagraph(
      'Contract revision fee: Once this contract is reviewed and signed by both parties, any tuition ' +
      'contract revisions that do not involve adding additional time (and are not due to a School error) ' +
      'will incur a $25 contract revision fee per revision.',
    ),

    blockSection('Acknowledgments'),
    checkboxF('ack_handbook',
      'I have read, reviewed, and signed the Parent Handbook and Nondiscrimination Policy Acknowledgment.',
      { required: true }),
    checkboxF('ack_amounts',
      'The amounts above are correct as listed on my enrollment paperwork.',
      { required: true }),
    checkboxF('ack_terms',
      'I have read and agree to the standard terms above (trial period, withdrawal policy, late fees, contract revision).',
      { required: true }),

    blockSection('Signature'),
    blockParagraph(ESIG_CONSENT, 'note'),
    txt('parent_signature',
      'Parent / Guardian — type your full legal name to sign',
      { required: true, prefill: 'parent.full_name' }),
    dateF('signature_date',
      'Date signed',
      { required: true, prefill: 'today' }),

    blockSection('School Operator Signature',
      'Pre-signed by the Head of School on behalf of Media Children\'s House.'),
    signatureStamp('Victoria Whitby', 'Head of School, Media Children\'s House', '2026-06-01'),
  ],
};

async function main() {
  console.log(`Seeding MCH Tuition Agreement form${args.refresh ? ' (refresh)' : ''}\n`);

  const existing = await pool.query(
    `SELECT id, needs_review FROM portal_form_definitions
      WHERE school_id = $1 AND slug = $2`,
    [MCH_SCHOOL_ID, form.slug],
  );

  if (existing.rowCount === 0) {
    await pool.query(
      `INSERT INTO portal_form_definitions
         (school_id, slug, display_name, description, category, per_student,
          is_active, needs_review, allow_addendum, resubmission_allowed,
          one_submission_per_year,
          field_schema, ghl_writeback, notify_emails, webhook_urls,
          confirmation_message, audience)
       VALUES ($1, $2, $3, $4, $5, $6, true, false, false, false, true,
               $7::jsonb, '[]'::jsonb, $8::text[], '{}'::text[], $9, 'parents')`,
      [MCH_SCHOOL_ID, form.slug, form.display_name, form.description,
       form.category, form.per_student,
       JSON.stringify(form.field_schema), form.notify_emails, form.confirmation_message],
    );
    console.log(`  ✓ created ${form.slug}`);
  } else if (existing.rows[0].needs_review === false && !args.refresh) {
    console.log(`  ⊝ skipped ${form.slug} (already curated; pass --refresh to override)`);
  } else {
    await pool.query(
      `UPDATE portal_form_definitions
          SET display_name = $3, description = $4, category = $5, per_student = $6,
              field_schema = $7::jsonb, notify_emails = $8::text[],
              confirmation_message = $9,
              one_submission_per_year = true, resubmission_allowed = false,
              audience = 'parents', is_active = true,
              needs_review = false, updated_at = now()
        WHERE school_id = $1 AND slug = $2`,
      [MCH_SCHOOL_ID, form.slug, form.display_name, form.description,
       form.category, form.per_student,
       JSON.stringify(form.field_schema), form.notify_emails, form.confirmation_message],
    );
    console.log(`  ↻ updated ${form.slug}`);
  }

  console.log('\nDone.');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => pool.end());

function parseArgs(argv) {
  return { refresh: argv.includes('--refresh') };
}
