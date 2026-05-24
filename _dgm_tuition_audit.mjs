import pg from 'pg';
import { readFileSync } from 'node:fs';
const env = readFileSync('.env.local', 'utf8');
const dbUrl = env.match(/^DATABASE_URL=(.*)$/m)?.[1]?.trim();
const c = new pg.Client({ connectionString: dbUrl });
await c.connect();
const dgm = 'cfa9030d-c8fe-49ae-a9e7-f1003844ec07';

console.log('=== TUITION GRIDS (what we have) ===\n');
const tg = await c.query(`
  SELECT academic_year, program, grade_level, annual_tuition_cents, addons
  FROM tuition_grids WHERE school_id = $1
  ORDER BY annual_tuition_cents DESC
`, [dgm]);
for (const r of tg.rows) {
  const annual = (r.annual_tuition_cents / 100).toLocaleString();
  console.log(`  [${r.academic_year}] ${r.program ?? '—'} / ${r.grade_level ?? '—'} → $${annual}`);
  if (r.addons && Array.isArray(r.addons) && r.addons.length) {
    for (const a of r.addons) console.log(`     addon: ${a.label ?? a.name} → $${((a.amount_cents ?? 0)/100).toLocaleString()}`);
  }
}

console.log('\n=== PAYMENT PLANS (what we have) ===\n');
const pp = await c.query(`
  SELECT slug, display_name, installment_count, discount_basis_points, schedule_template, metadata
  FROM payment_plans WHERE school_id = $1
`, [dgm]);
for (const r of pp.rows) {
  console.log(`  ${r.display_name} (slug: ${r.slug})`);
  console.log(`     installments: ${r.installment_count}, discount_bp: ${r.discount_basis_points}, schedule: ${r.schedule_template}`);
  if (r.metadata) console.log(`     metadata: ${JSON.stringify(r.metadata)}`);
}

console.log('\n=== DISCOUNT POLICIES (what we have) ===\n');
const dp = await c.query(`
  SELECT name, code, kind, percentage_basis_points, amount_cents, conditions, max_redemptions, active
  FROM discount_policies WHERE school_id = $1
`, [dgm]);
for (const r of dp.rows) {
  console.log(`  ${r.name} (kind: ${r.kind}, active: ${r.active})`);
  if (r.percentage_basis_points) console.log(`     ${r.percentage_basis_points / 100}% off`);
  if (r.amount_cents) console.log(`     $${(r.amount_cents/100).toLocaleString()} off`);
  if (r.code) console.log(`     code: ${r.code}`);
  if (r.conditions) console.log(`     conditions: ${JSON.stringify(r.conditions)}`);
}

console.log('\n=== SCHOOL PAYMENT CONFIG (settings) ===\n');
const cfg = await c.query(`SELECT * FROM school_payment_config WHERE school_id = $1`, [dgm]);
if (cfg.rows[0]) {
  const r = cfg.rows[0];
  console.log(`  late_fee_amount_cents: $${(r.late_fee_amount_cents/100).toFixed(2)}`);
  console.log(`  late_fee_grace_days: ${r.late_fee_grace_days}`);
  console.log(`  autopay_days: ${JSON.stringify(r.autopay_days)}`);
  console.log(`  retry_schedule_days: ${JSON.stringify(r.retry_schedule_days)}`);
  console.log(`  enrollment_fee_early_cents: $${(r.enrollment_fee_early_cents/100).toFixed(0)}`);
  console.log(`  enrollment_fee_late_cents: $${(r.enrollment_fee_late_cents/100).toFixed(0)}`);
  console.log(`  enrollment_fee_cutoff: ${r.enrollment_fee_cutoff_date}`);
  console.log(`  monthly_plan_admin_fee_bp: ${r.monthly_plan_admin_fee_bp} (${r.monthly_plan_admin_fee_bp/100}%)`);
  console.log(`  annual_plan_discount_bp: ${r.annual_plan_discount_bp} (${r.annual_plan_discount_bp/100}%)`);
  console.log(`  pass_card_fee: ${r.pass_card_fee}`);
  console.log(`  ach_enabled: ${r.ach_enabled}`);
}

await c.end();
