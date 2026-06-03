// Regenerate MCH tuition invoices in place for every active enrollment.
//
// Use this after changing payment_plans.schedule_template /
// first_due_month_day so existing DRAFT (and OPEN, unpaid) invoices get
// rewritten with the new due dates. PAID / PARTIALLY_PAID invoices are
// preserved by the generator's delete clause.
//
// Idempotent — re-runs are safe.
//
// Usage:
//   npx tsx scripts/regen-mch-tuition-invoices.mjs           # apply
//   npx tsx scripts/regen-mch-tuition-invoices.mjs --dry-run # list only

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const SCHOOL_ID = 'a6c4b2dd-050c-4bf9-893b-67106f0f20e8'; // MCH

const { Pool } = await import('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Lazy-load the TS generator through tsx.
const { generateTuitionEnrollment } = await import('../lib/billing/tuition-plan-generator.ts');

const { rows: enrollments } = await pool.query(
  `SELECT fte.id, fte.family_id, fte.student_id, fte.academic_year,
          fte.tuition_grid_id, fte.payment_plan_id, fte.addons,
          f.display_name AS family_label,
          pp.slug AS plan_slug, pp.installment_count
     FROM family_tuition_enrollments fte
     JOIN families f ON f.id = fte.family_id
     JOIN payment_plans pp ON pp.id = fte.payment_plan_id
    WHERE fte.school_id = $1 AND fte.status = 'active'
    ORDER BY f.display_name`,
  [SCHOOL_ID],
);

console.log(`Regenerating ${enrollments.length} MCH enrollments${dryRun ? ' (DRY RUN)' : ''}…\n`);

let ok = 0, failed = 0;
for (const e of enrollments) {
  const addonKeys = Array.isArray(e.addons) ? e.addons.map((a) => a.key) : [];
  const label = `${e.family_label || '(unnamed)'} · ${e.plan_slug} (${e.installment_count})`;
  if (dryRun) {
    console.log(`  • DRY: ${label}`);
    continue;
  }
  try {
    const res = await generateTuitionEnrollment({
      schoolId: SCHOOL_ID,
      familyId: e.family_id,
      studentId: e.student_id,
      academicYear: e.academic_year,
      tuitionGridId: e.tuition_grid_id,
      paymentPlanId: e.payment_plan_id,
      addonKeys,
      createdByEmail: 'regen@growthsuite.local',
      initialStatus: 'draft', // dry-run mode gate will keep it draft anyway
    });
    // Peek at the first + last due dates so we can eyeball success.
    const { rows: dates } = await pool.query(
      `SELECT min(due_at)::date AS first_due, max(due_at)::date AS last_due
         FROM invoices
        WHERE source = 'tuition_plan'
          AND source_ref->>'enrollment_id' = $1`,
      [e.id],
    );
    const fd = dates[0]?.first_due ?? '?';
    const ld = dates[0]?.last_due ?? '?';
    console.log(`  ✓ ${label.padEnd(60)} ${res.invoice_ids.length} invoices · ${fd} → ${ld}`);
    ok++;
  } catch (err) {
    console.log(`  ✗ ${label} — ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

console.log(`\nDone. ${ok} ok, ${failed} failed.`);
await pool.end();
process.exit(failed > 0 ? 1 : 0);
