// Push every MCH 2026-27 tuition enrollment to its family's GHL contact
// record. Uses the shared writebackTuitionEnrollmentToGhl() helper which
// resolves the per-slot custom field keys from school_field_schemas.
//
// Idempotent — GHL writes are PUTs that replace only the listed keys,
// so re-running just refreshes the values.
//
// Usage:
//   node scripts/writeback-mch-tuition-ghl.mjs            # write everything
//   node scripts/writeback-mch-tuition-ghl.mjs --dry-run  # log what would happen
//   node scripts/writeback-mch-tuition-ghl.mjs --limit 5  # cap for testing

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

// Need to register the TS loader so the writeback helper (TypeScript) is importable.
// Since this is a one-off script, we use tsx via the import path.
const args = parseArgs(process.argv.slice(2));
const MCH_SCHOOL_ID = 'a6c4b2dd-050c-4bf9-893b-67106f0f20e8';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  console.log(`MCH tuition → GHL writeback${args.dryRun ? ' (DRY RUN)' : ''}\n`);

  const { rows } = await pool.query(
    `SELECT fte.id, fte.family_id, fte.student_id,
            fte.annual_tuition_cents, fte.total_annual_cents,
            s.first_name, s.last_name,
            (SELECT pp.display_name FROM payment_plans pp WHERE pp.id = fte.payment_plan_id) AS plan,
            (SELECT p.ghl_contact_id FROM parents p
              WHERE p.family_id = fte.family_id AND p.is_primary = true
                AND p.ghl_contact_id IS NOT NULL
              ORDER BY p.created_at LIMIT 1) AS ghl_contact_id
       FROM family_tuition_enrollments fte
       JOIN students s ON s.id = fte.student_id
      WHERE fte.school_id = $1 AND fte.status = 'active'
      ORDER BY s.first_name, s.last_name`,
    [MCH_SCHOOL_ID],
  );

  console.log(`Found ${rows.length} active enrollments\n`);

  let ok = 0, skipped_no_ghl = 0, failed = 0, dry = 0;
  const errors = [];
  const limit = args.limit ?? rows.length;

  // Lazy-import the helper so this script works even before tsx is set up
  let writeback;
  if (!args.dryRun) {
    try {
      ({ writebackTuitionEnrollmentToGhl: writeback } = await import('../lib/billing/tuition-ghl-writeback.ts'));
    } catch (err) {
      console.error('Failed to load TS writeback helper:', err instanceof Error ? err.message : String(err));
      console.error('Try: npx tsx scripts/writeback-mch-tuition-ghl.mjs');
      process.exit(1);
    }
  }

  for (let i = 0; i < Math.min(rows.length, limit); i++) {
    const e = rows[i];
    const studentLabel = `${e.first_name} ${e.last_name}`.padEnd(28);
    const annualDollars = `$${(e.total_annual_cents / 100).toFixed(0)}`.padEnd(8);
    const plan = String(e.plan ?? '?').padEnd(35);

    if (!e.ghl_contact_id) {
      console.log(`  ⊘ ${studentLabel}  ${annualDollars}  ${plan}  (no GHL contact for primary parent)`);
      skipped_no_ghl++;
      continue;
    }

    if (args.dryRun) {
      console.log(`  • DRY ${studentLabel}  ${annualDollars}  ${plan}  → GHL ${e.ghl_contact_id}`);
      dry++;
      continue;
    }

    try {
      const r = await writeback(e.id);
      if (r.ok) {
        console.log(`  ✓ ${studentLabel}  ${annualDollars}  ${plan}  → GHL ${e.ghl_contact_id} (${r.fieldsWritten?.length ?? 0} fields)`);
        ok++;
      } else {
        console.log(`  ✗ ${studentLabel}  ${annualDollars}  ${plan}  (${r.reason})`);
        failed++;
        errors.push(`${e.first_name} ${e.last_name}: ${r.reason}`);
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.log(`  ✗ ${studentLabel}  ${annualDollars}  ${plan}  (exception: ${m.slice(0, 60)})`);
      failed++;
      errors.push(`${e.first_name} ${e.last_name}: ${m}`);
    }
  }

  console.log(`\nDone. ${ok} ok, ${skipped_no_ghl} skipped (no GHL contact), ${failed} failed${args.dryRun ? `, ${dry} dry` : ''}`);
  if (errors.length > 0) {
    console.log('\nErrors:');
    for (const e of errors) console.log('  •', e);
  }
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => pool.end());

function parseArgs(argv) {
  const out = { dryRun: false, limit: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') out.dryRun = true;
    if (argv[i] === '--limit') out.limit = Number(argv[++i]);
  }
  return out;
}
