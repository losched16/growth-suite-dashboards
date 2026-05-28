// Seed Media Children's House tuition system.
//
// Sets up everything except per-family enrollments:
//   1. school_payment_config (Stripe / autopay / late fee defaults)
//   2. payment_plans (Option A 1-pmt 3% disc, Option B 2-pmt 2% disc, Option C 10-pmt)
//   3. tuition_grids (one per program × schedule combo from the 2026-27 Schedule of Tuitions PDF)
//   4. payments dashboard (provisioned with payments_overview + financial_aid_queue widgets)
//
// Source: mch-forms/Tuition Forms/Enrollment 2026-2027 - 2026-27 Tuition Schedule.pdf
//
// Idempotent: upserts on (school_id, slug) for plans, (school_id, academic_year, program, display_name)
// for grids. Re-runnable.
//
// Usage:
//   node scripts/seed-mch-tuition.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
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

const MCH_SCHOOL_ID = 'a6c4b2dd-050c-4bf9-893b-67106f0f20e8';
const ACADEMIC_YEAR = '2026-27';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── 1. school_payment_config ────────────────────────────────────────
// Mirrors DGM defaults with MCH-specific tweaks:
//   - late_fee: $1/day after 5-day grace (per MCH contract template)
//   - autopay day: 15th (per MCH "due on the 15th of each month")
//   - ACH enabled w/ $5 convenience fee passed to parent
async function seedPaymentConfig() {
  await pool.query(
    `INSERT INTO school_payment_config
       (school_id, pass_card_fee, pass_ach_fee, processing_fee_label,
        autopay_days, late_fee_amount_cents, late_fee_grace_days,
        retry_schedule_days, invoice_number_prefix, next_invoice_number,
        default_currency, ach_enabled, card_enabled,
        waive_platform_setup_fee, monthly_plan_admin_fee_bp, annual_plan_discount_bp,
        plan_change_fee_cents, withdrawal_fee_cents, withdrawal_notice_days)
     VALUES ($1, true, true, 'ACH convenience fee',
             ARRAY[15], 100, 5,
             ARRAY[1, 3, 7], 'MCH', 1,
             'usd', true, true,
             true, 0, 0,
             2500, 0, 30)
     ON CONFLICT (school_id) DO UPDATE SET
       autopay_days = EXCLUDED.autopay_days,
       late_fee_amount_cents = EXCLUDED.late_fee_amount_cents,
       late_fee_grace_days = EXCLUDED.late_fee_grace_days,
       plan_change_fee_cents = EXCLUDED.plan_change_fee_cents,
       updated_at = now()`,
    [MCH_SCHOOL_ID],
  );
  console.log('  ✓ school_payment_config');
}

// ── 2. payment_plans ────────────────────────────────────────────────
// Mirrors MCH's 3 tuition options:
//   - Option A: 1 payment, 3% discount, due July 15
//   - Option B: 2 payments, 2% discount, due July 15 + Dec 15
//   - Option C: 10 payments, no discount, due 15th of each month Jul-Apr
const PLANS = [
  {
    slug: 'annual',
    display_name: 'Annual Payment (3% discount)',
    description: '100% of net tuition discounted 3%, due on July 15th.',
    installment_count: 1,
    discount_basis_points: 300,
    schedule_template: { kind: 'single', months: ['07'] },
    first_due_month_day: '07-15',
    position: 1,
  },
  {
    slug: 'semi-annual',
    display_name: 'Semi-Annual Payment (2% discount)',
    description: '50% of net tuition discounted 2%, first payment July 15th, second December 15th.',
    installment_count: 2,
    discount_basis_points: 200,
    schedule_template: { kind: 'semiannual', months: ['07', '12'] },
    first_due_month_day: '07-15',
    position: 2,
  },
  {
    slug: 'monthly',
    display_name: 'Monthly Payment (10 installments)',
    description: '10 monthly payments, due on the 15th of each month from July 15 through April 15.',
    installment_count: 10,
    discount_basis_points: 0,
    schedule_template: { kind: 'monthly', months: ['07','08','09','10','11','12','01','02','03','04'] },
    first_due_month_day: '07-15',
    position: 3,
  },
];

async function seedPaymentPlans() {
  for (const p of PLANS) {
    await pool.query(
      `INSERT INTO payment_plans
         (school_id, slug, display_name, description, installment_count, discount_basis_points,
          schedule_template, is_active, position, first_due_month_day)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, true, $8, $9)
       ON CONFLICT (school_id, slug) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         description = EXCLUDED.description,
         installment_count = EXCLUDED.installment_count,
         discount_basis_points = EXCLUDED.discount_basis_points,
         schedule_template = EXCLUDED.schedule_template,
         is_active = true,
         position = EXCLUDED.position,
         first_due_month_day = EXCLUDED.first_due_month_day,
         updated_at = now()`,
      [MCH_SCHOOL_ID, p.slug, p.display_name, p.description, p.installment_count, p.discount_basis_points,
       JSON.stringify(p.schedule_template), p.position, p.first_due_month_day],
    );
    console.log(`  ✓ payment_plan: ${p.slug}`);
  }
}

// ── 3. tuition_grids ────────────────────────────────────────────────
// One row per (program × schedule) combo from the rate card. Each grid's
// annual_tuition_cents is what a family pays BEFORE plan discounts.
//
// MCH's "addons" (extended care, development fee, late pickup) are NOT
// rolled into grid base prices — they're separate billable add-ons applied
// per-enrollment. For the initial seed we leave the addons array empty
// and let admins enable extended care per-family via the enrollment edit
// UI (or via the import script which can pre-populate).
// (program, grade_level) must be unique per (school, academic_year). We
// encode the schedule into `program` so each schedule option is its own
// row; `grade_level` remains the broad age bucket (matches DGM's pattern).
const GRIDS = [
  // Young Community (18 months to 3 years)
  { program: 'YC — 2 Days, Half Day',  grade_level: 'Young Community', display_name: 'YC — 2 Days, Half Day (9am–11:30am)',  annual: 594500, position: 11 },
  { program: 'YC — 2 Days, Full Day',  grade_level: 'Young Community', display_name: 'YC — 2 Days, Full Day (9am–2:45pm)',   annual: 870000, position: 12 },
  { program: 'YC — 3 Days, Half Day',  grade_level: 'Young Community', display_name: 'YC — 3 Days, Half Day',                annual: 840000, position: 13 },
  { program: 'YC — 3 Days, Full Day',  grade_level: 'Young Community', display_name: 'YC — 3 Days, Full Day',                annual: 1100000, position: 14 },
  { program: 'YC — 5 Days, Half Day',  grade_level: 'Young Community', display_name: 'YC — 5 Days, Half Day',                annual: 1015000, position: 15 },
  { program: 'YC — 5 Days, Full Day',  grade_level: 'Young Community', display_name: 'YC — 5 Days, Full Day',                annual: 1330000, position: 16 },

  // Primary (3 to 5 years)
  { program: 'Primary — 3 Days, Half Day', grade_level: 'Primary',      display_name: 'Primary — 3 Days, Half Day (8:45am–11:45am)',  annual: 813500, position: 21 },
  { program: 'Primary — 3 Days, Full Day', grade_level: 'Primary',      display_name: 'Primary — 3 Days, Full Day (8:45am–2:45pm)',   annual: 1040000, position: 22 },
  { program: 'Primary — 5 Days, Half Day', grade_level: 'Primary',      display_name: 'Primary — 5 Days, Half Day',                   annual: 980000, position: 23 },
  { program: 'Primary — 5 Days, Full Day', grade_level: 'Primary',      display_name: 'Primary — 5 Days, Full Day',                   annual: 1280000, position: 24 },

  // Kindergarten (5+ years)
  { program: 'Kindergarten — 5 Full Days', grade_level: 'Kindergarten', display_name: 'Kindergarten — 5 Full Days (8:30am–3:15pm)',   annual: 1350000, position: 31 },
];

async function seedTuitionGrids() {
  for (const g of GRIDS) {
    // tuition_grids doesn't have a natural unique key beyond (school_id, academic_year, display_name).
    // We use that as the conflict target by selecting + inserting if missing, then updating amount.
    const existing = await pool.query(
      `SELECT id FROM tuition_grids
        WHERE school_id = $1 AND academic_year = $2 AND program = $3 AND grade_level = $4`,
      [MCH_SCHOOL_ID, ACADEMIC_YEAR, g.program, g.grade_level],
    );
    if (existing.rowCount > 0) {
      await pool.query(
        `UPDATE tuition_grids
            SET annual_tuition_cents = $1, display_name = $2,
                is_active = true, position = $3, updated_at = now()
          WHERE id = $4`,
        [g.annual, g.display_name, g.position, existing.rows[0].id],
      );
      console.log(`  ↻ grid: ${g.display_name}`);
    } else {
      await pool.query(
        `INSERT INTO tuition_grids
           (school_id, academic_year, program, grade_level, display_name,
            annual_tuition_cents, addons, is_active, position)
         VALUES ($1, $2, $3, $4, $5, $6, '[]'::jsonb, true, $7)`,
        [MCH_SCHOOL_ID, ACADEMIC_YEAR, g.program, g.grade_level, g.display_name, g.annual, g.position],
      );
      console.log(`  ✓ grid: ${g.display_name} ($${(g.annual / 100).toFixed(0)})`);
    }
  }
}

// ── 4. payments dashboard ───────────────────────────────────────────
// Mirrors DGM's payments dashboard (payments_overview + financial_aid_queue).
async function provisionPaymentsDashboard() {
  const layout = [
    {
      instance_id: randomUUID(),
      widget_id: 'payments_overview',
      config: { recent_limit: 10, failure_window_days: 14 },
      position: { x: 0, y: 0, w: 12, h: 8 },
    },
    {
      instance_id: randomUUID(),
      widget_id: 'financial_aid_queue',
      config: {
        default_recommended_award_floor: 1000,
        default_recommended_award_ceiling: 15000,
      },
      position: { x: 0, y: 8, w: 12, h: 16 },
    },
  ];

  await pool.query(
    `INSERT INTO school_dashboards
       (school_id, dashboard_slug, display_name, description, layout, is_enabled, position)
     VALUES ($1, $2, $3, $4, $5::jsonb, true, $6)
     ON CONFLICT (school_id, dashboard_slug) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       description = EXCLUDED.description,
       layout = EXCLUDED.layout,
       is_enabled = true,
       position = EXCLUDED.position,
       updated_at = now()`,
    [
      MCH_SCHOOL_ID,
      'payments',
      'Payments',
      'Tuition enrollments, invoices, payment activity, and financial aid queue.',
      JSON.stringify(layout),
      140,
    ],
  );
  console.log('  ✓ payments dashboard provisioned');
}

async function main() {
  console.log('Seeding MCH tuition system (school_id', MCH_SCHOOL_ID, ')\n');
  console.log('— school_payment_config —');
  await seedPaymentConfig();
  console.log('\n— payment_plans —');
  await seedPaymentPlans();
  console.log('\n— tuition_grids —');
  await seedTuitionGrids();
  console.log('\n— payments dashboard —');
  await provisionPaymentsDashboard();
  console.log('\nDone. Now run:');
  console.log('  node scripts/import-mch-tuition-survey.mjs');
  console.log('to create per-family enrollments from the Tuition Survey responses.');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => pool.end());
