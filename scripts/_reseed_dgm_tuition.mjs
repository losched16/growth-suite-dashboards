// Reseed DGM tuition + payment plans + discounts + fees to match the
// 2026-27 Enrollment Agreement exactly. The existing DB has
// preview/seed data that doesn't reflect DGM's real rates.
//
// SOURCE OF TRUTH for THIS file = the 2026-27 Enrollment Agreement PDF.
// Per-family actual amounts (after sibling/scholarship/FA) are NOT set
// here — those come from the FACTS CSV import (separate script).
//
// Idempotent: wipes DGM's tuition_grids + discount_policies, replaces
// with the correct rows. Existing family_tuition_enrollments are left
// alone (they may have been hand-created during testing and shouldn't
// be auto-wiped — handle separately if needed).

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

const DGM_SCHOOL_ID = 'cfa9030d-c8fe-49ae-a9e7-f1003844ec07';
const ACADEMIC_YEAR = '2026-27';
const DRY_RUN = process.argv.includes('--dry-run');

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ─── BASE TUITION GRIDS (per Enrollment Agreement) ─────────────────────
// Annual figures, in CENTS. These are list prices — actual per-family
// amounts come from FACTS CSV (sibling 10%, Annual 5%, FA, etc.
// applied there).

// Add-ons (both annual cents):
// - Extended Day: $4,950 annual / $495 monthly — until 6pm
//                 INCLUDES Childcare Days
// - Organic Lunch: $2,100 annual / $210 monthly
//                  INCLUDED in tuition for Infant/Toddler/Primary
//                  (so the addon is ONLY surfaced for Elementary+
//                  and Middle Years/High School grids).
const EXTENDED_DAY_ADDON = {
  key: 'extended_day',
  label: 'Extended Day (until 6pm, includes Childcare Days)',
  amount_cents: 495_000,
  monthly_cents: 49_500,
  category: 'care',
  cancellation_fee_cents: 10_000,
  cancellation_notice_day_of_month: 15,
  description:
    'Extended Day care/supervision until 6pm. Billed for the entire 10-month '
    + 'year. Prorated monthly. $100 cancellation fee. Includes Childcare Days.',
};
const ORGANIC_LUNCH_ADDON = {
  key: 'organic_lunch',
  label: 'Organic Lunch',
  amount_cents: 210_000,
  monthly_cents: 21_000,
  category: 'meal',
  re_enrollment_fee_cents: 10_000,
  description:
    'Organic Lunch. Billed for the entire 10-month year. Prorated monthly. '
    + 'No cancellation fee. $100 re-enrollment fee.',
};

const GRIDS = [
  // The (school_id, academic_year, program, grade_level) UNIQUE
  // constraint means two grids can't share all four. Toddler/Primary
  // has two schedules at different prices — we differentiate them via
  // the `program` slug ("Toddler/Primary — Half Day" vs "School Day")
  // so each grid is uniquely keyed AND the schedule is human-readable.
  {
    program: 'Infant — School Day',
    grade_level: 'Infant',
    display_name: 'Infant — School Day (8:30am–2:30pm)',
    annual_tuition_cents: 1_950_000,
    addons: [EXTENDED_DAY_ADDON],           // Lunch INCLUDED in tuition
    position: 10,
  },
  {
    program: 'Toddler/Primary — Half Day',
    grade_level: 'Toddler/Primary',
    display_name: 'Toddler/Primary — Half Day (8:30am–12pm)',
    annual_tuition_cents: 1_300_000,
    addons: [EXTENDED_DAY_ADDON],           // Lunch INCLUDED
    position: 20,
  },
  {
    program: 'Toddler/Primary — School Day',
    grade_level: 'Toddler/Primary',
    display_name: 'Toddler/Primary — School Day (8:30am–2:30pm)',
    annual_tuition_cents: 1_625_000,
    addons: [EXTENDED_DAY_ADDON],           // Lunch INCLUDED
    position: 30,
  },
  {
    program: 'Lower Elementary — School Day',
    grade_level: 'Lower Elementary',
    display_name: 'Lower Elementary — School Day (8am–3:15pm)',
    annual_tuition_cents: 1_400_000,
    addons: [EXTENDED_DAY_ADDON, ORGANIC_LUNCH_ADDON],
    position: 40,
  },
  {
    program: 'Upper Elementary — School Day',
    grade_level: 'Upper Elementary',
    display_name: 'Upper Elementary — School Day (8am–3:30pm)',
    annual_tuition_cents: 1_400_000,
    addons: [EXTENDED_DAY_ADDON, ORGANIC_LUNCH_ADDON],
    position: 50,
  },
  {
    program: 'Middle Years/High School — School Day',
    grade_level: 'Middle Years/High School',
    display_name: 'Middle Years / High School — School Day (8am–3:30pm)',
    annual_tuition_cents: 1_730_000,
    addons: [EXTENDED_DAY_ADDON, ORGANIC_LUNCH_ADDON],
    position: 60,
  },
];

// ─── PAYMENT PLANS (per agreement) ────────────────────────────────────
// Months are 2-digit zero-padded strings (matches existing convention).
// Per agreement:
//  - Annual: 1 payment due July 1 (or before late start). −5% discount.
//  - Semi-Annual: 2 payments due July 1 and December 1.
//  - Monthly: 10 payments due 1st of each month, billed 30 days in
//    advance. August tuition due July 1, final May tuition due April 1.
//    So invoice months are July through April (07–04). +3% admin fee
//    (handled via school_payment_config.monthly_plan_admin_fee_bp, not
//    on the plan's discount_basis_points which represents only the
//    plan's own discount).
const PLANS = [
  {
    slug: 'annual',
    display_name: 'Annual Payment Plan',
    description:
      'Single payment due July 1 (or before late start date) covering the full '
      + '10-month academic year. Includes a 5% Annual Discount applied to tuition. '
      + 'Annual Discount cannot stack with Sibling Discount.',
    installment_count: 1,
    discount_basis_points: 500,  // 5% Annual Discount per agreement
    schedule_template: { kind: 'single', months: ['07'] },
    position: 10,
  },
  {
    slug: 'semi-annual',
    display_name: 'Semi-Annual Payment Plan',
    description:
      'Two equal payments due July 1 and December 1. Not available to late '
      + 'enrollees.',
    installment_count: 2,
    discount_basis_points: 0,
    schedule_template: { kind: 'semiannual', months: ['07', '12'] },
    position: 20,
  },
  {
    slug: 'monthly',
    display_name: 'Monthly Payment Plan',
    description:
      '10 equal automatic payments due on the 1st of each month, billed 30 days '
      + 'in advance. August tuition due July 1, final May tuition due April 1. '
      + 'Includes a 3% Administrative Fee on Annual Tuition.',
    installment_count: 10,
    discount_basis_points: 0,  // upcharge handled via school config admin fee
    schedule_template: {
      kind: 'monthly',
      // July through April = 10 months. Each covers the following
      // month's tuition (billed 30 days in advance per agreement).
      months: ['07', '08', '09', '10', '11', '12', '01', '02', '03', '04'],
    },
    position: 30,
  },
];

// ─── DISCOUNT POLICIES (per agreement) ─────────────────────────────────
// Three policies. The Annual 5% lives on the payment plan itself (above);
// the agreement makes clear that the Annual Discount is granted by
// SELECTING the Annual plan, so plan-level is correct. We surface the
// MUTUAL EXCLUSION between Sibling + Annual via a conditions flag.
const DISCOUNTS = [
  {
    kind: 'auto',
    display_name: 'Sibling Discount',
    internal_note:
      'Per 2026-27 enrollment agreement: 10% off Annual Tuition for younger '
      + 'siblings concurrently enrolled. CANNOT stack with the 5% Annual '
      + 'Discount that comes with the Annual Payment Plan.',
    percentage_basis_points: 1000,         // 10%
    amount_cents: 0,
    max_discount_cents: null,
    applies_to_categories: ['tuition'],
    conditions: {
      // Triggers when 2+ children from the same family are concurrently
      // enrolled. Applies only to the YOUNGER sibling(s), not the oldest.
      min_children_enrolled: 2,
      applies_to_younger_siblings_only: true,
      mutually_exclusive_with_plans: ['annual'],
    },
    redemption_code: null,
    max_total_redemptions: null,
    max_redemptions_per_family: 0,
    is_active: true,
  },
  {
    kind: 'auto',
    display_name: 'Referral Credit',
    internal_note:
      'Per 2026-27 enrollment agreement: $500 one-time credit to a currently '
      + 'enrolled student when a referred family completes their first academic '
      + 'year. Does NOT apply to siblings of the enrolling family.',
    percentage_basis_points: 0,
    amount_cents: 50_000,                  // $500 flat
    max_discount_cents: 50_000,
    applies_to_categories: ['tuition'],
    conditions: {
      applies_when: 'referrer_student_completed_year',
      excludes_siblings: true,
      one_time_only: true,
    },
    redemption_code: null,
    max_total_redemptions: null,
    max_redemptions_per_family: 1,
    is_active: true,
  },
];

// ─── SCHOOL PAYMENT CONFIG UPDATES ─────────────────────────────────────
// Per the agreement's Late Payments + Other Fees + Withdrawal sections.
const CONFIG_UPDATES = {
  late_fee_amount_cents: 4_000,            // $40 per agreement
  late_fee_grace_days: 15,                 // 15-day grace per agreement
  plan_change_fee_cents: 3_000,            // $30 per agreement
  withdrawal_fee_cents: 200_000,           // $2,000 per agreement
  withdrawal_notice_days: 30,              // 30 days written notice
  // Enrollment fees already correctly set:
  //   enrollment_fee_early_cents = 39500 ($395)
  //   enrollment_fee_late_cents  = 59500 ($595)
  //   enrollment_fee_cutoff_date = 2026-01-31
  monthly_plan_admin_fee_bp: 300,          // confirm 3% (already set)
  annual_plan_discount_bp: 500,            // confirm 5% (already set)
};

// ─── EXECUTION ────────────────────────────────────────────────────────

async function main() {
  if (DRY_RUN) console.log('[DRY RUN] no writes will be made\n');

  const c = await pool.connect();
  try {
    await c.query('BEGIN');

    // 0. WIPE preview/test invoices + enrollments that reference the old
    // wrong grids. User confirmed all 17 existing invoices are test data,
    // and the only family_tuition_enrollment is for "Johnson Family"
    // (created_by: preview-seed@growthsuite.local). Wiping in dependency
    // order so foreign keys don't block.
    const invLines = await c.query(
      `DELETE FROM invoice_line_items
        WHERE invoice_id IN (SELECT id FROM invoices WHERE school_id = $1)`,
      [DGM_SCHOOL_ID],
    );
    console.log(`Wiped ${invLines.rowCount} invoice_line_items`);
    const invs = await c.query(`DELETE FROM invoices WHERE school_id = $1`, [DGM_SCHOOL_ID]);
    console.log(`Wiped ${invs.rowCount} test invoices`);
    const enrolls = await c.query(`DELETE FROM family_tuition_enrollments WHERE school_id = $1`, [DGM_SCHOOL_ID]);
    console.log(`Wiped ${enrolls.rowCount} preview enrollments`);

    // 1. WIPE existing tuition_grids for DGM (8 wrong rows)
    const before = await c.query(`SELECT count(*) FROM tuition_grids WHERE school_id = $1`, [DGM_SCHOOL_ID]);
    console.log(`Existing tuition_grids for DGM: ${before.rows[0].count}`);
    await c.query(`DELETE FROM tuition_grids WHERE school_id = $1`, [DGM_SCHOOL_ID]);

    // 2. INSERT correct grids
    for (const g of GRIDS) {
      await c.query(
        `INSERT INTO tuition_grids
           (school_id, academic_year, program, grade_level, display_name,
            annual_tuition_cents, addons, is_active, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, true, $8)`,
        [
          DGM_SCHOOL_ID, ACADEMIC_YEAR, g.program, g.grade_level, g.display_name,
          g.annual_tuition_cents, JSON.stringify(g.addons), g.position,
        ],
      );
      console.log(`  + grid ${g.display_name.padEnd(60)} $${(g.annual_tuition_cents/100).toLocaleString()}`);
    }

    // 3. UPSERT payment plans
    await c.query(`DELETE FROM payment_plans WHERE school_id = $1`, [DGM_SCHOOL_ID]);
    for (const p of PLANS) {
      await c.query(
        `INSERT INTO payment_plans
           (school_id, slug, display_name, description, installment_count,
            discount_basis_points, schedule_template, is_active, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, true, $8)`,
        [
          DGM_SCHOOL_ID, p.slug, p.display_name, p.description,
          p.installment_count, p.discount_basis_points,
          JSON.stringify(p.schedule_template), p.position,
        ],
      );
      console.log(`  + plan ${p.display_name} (${p.installment_count}×, discount ${p.discount_basis_points/100}%)`);
    }

    // 4. WIPE existing discount_policies for DGM (2 PREVIEW rows) and replace
    await c.query(`DELETE FROM discount_policies WHERE school_id = $1`, [DGM_SCHOOL_ID]);
    for (const d of DISCOUNTS) {
      await c.query(
        `INSERT INTO discount_policies
           (school_id, kind, display_name, internal_note,
            percentage_basis_points, amount_cents, max_discount_cents,
            applies_to_categories, conditions, redemption_code,
            max_total_redemptions, max_redemptions_per_family, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9::jsonb, $10, $11, $12, $13)`,
        [
          DGM_SCHOOL_ID, d.kind, d.display_name, d.internal_note,
          d.percentage_basis_points, d.amount_cents, d.max_discount_cents,
          d.applies_to_categories, JSON.stringify(d.conditions),
          d.redemption_code, d.max_total_redemptions, d.max_redemptions_per_family,
          d.is_active,
        ],
      );
      const pct = d.percentage_basis_points ? `${d.percentage_basis_points/100}%` : `$${(d.amount_cents/100).toFixed(0)}`;
      console.log(`  + discount ${d.display_name} (${d.kind}, ${pct})`);
    }

    // 5. UPDATE school_payment_config (assumes migration 036 has been applied)
    const setFields = Object.keys(CONFIG_UPDATES);
    const setExpr  = setFields.map((f, i) => `${f} = $${i + 2}`).join(', ');
    const values   = Object.values(CONFIG_UPDATES);
    await c.query(
      `UPDATE school_payment_config SET ${setExpr}, updated_at = now() WHERE school_id = $1`,
      [DGM_SCHOOL_ID, ...values],
    );
    console.log(`  + payment config updated (${setFields.length} fields)`);

    if (DRY_RUN) {
      await c.query('ROLLBACK');
      console.log('\n[DRY RUN] rolled back — no changes persisted.');
    } else {
      await c.query('COMMIT');
      console.log('\n✓ Reseed committed for DGM.');
    }
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
