// Import MCH's 2026-27 tuition survey responses into family_tuition_enrollments.
//
// Source: mch-forms/Tuition Forms/2026-27 School Year Tuition Survey (Responses) - Form Responses 1-2.pdf
//
// What the survey captures (per row):
//   - Student name (sometimes student 1 + student 2 in same row for siblings)
//   - Selected payment plan: "One Payment (3% Discount)" | "Two Payments (2% Discount)" | "10 Payments (July through April)"
//   - Payment method preference: Check | Cash | ACH
//
// What it does NOT capture: per-student program (YC/Primary/K) or schedule
// (days × half/full). We derive program from the student's classroom
// assignment + age, and default the schedule to "5 Days, Full Day" — which
// is MCH's most common configuration. Operators can correct individual
// rows via the parent-portal admin UI before the meeting if needed.
//
// Idempotent: each (family_id, student_id, academic_year) gets ONE
// active enrollment. Re-runs upsert.
//
// Usage:
//   node scripts/import-mch-tuition-survey.mjs            # write enrollments
//   node scripts/import-mch-tuition-survey.mjs --dry-run  # report-only

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
const ACADEMIC_YEAR = '2026-27';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── Survey responses (transcribed from the Tuition Survey PDF) ──────
// Format: { students: [name strings], plan: 'annual' | 'semi-annual' | 'monthly', method: 'check'|'cash'|'ach' }
// Names are matched case-insensitively against students.first_name; if there
// are two students at MCH with the same first name, the script falls back
// to first+last matching (and warns if still ambiguous).
const SURVEY_RESPONSES = [
  { students: ['Marcellus Colon'],                              plan: 'annual',      method: 'check' },
  { students: ['Aria Townsend'],                                plan: 'monthly',     method: 'check' },
  { students: ['Elynn'],                                        plan: 'monthly',     method: 'check' },
  { students: ['Scarlett Kelbaugh'],                            plan: 'annual',      method: 'check' },
  { students: ['Avery Gondos'],                                 plan: 'monthly',     method: 'check' },
  { students: ['Eitan Kline-Kiel'],                             plan: 'monthly',     method: 'ach' },
  { students: ['Adam Egbert'],                                  plan: 'annual',      method: 'check' },
  { students: ['Madison Arthur'],                               plan: 'monthly',     method: 'check' },
  { students: ['Penelope Nealis'],                              plan: 'semi-annual', method: 'ach' },
  { students: ['Rory Marlowe'],                                 plan: 'semi-annual', method: 'check' },
  { students: ['Dylan Meyer'],                                  plan: 'annual',      method: 'check' },
  { students: ['Tessa Tryens', 'Vivienne Tryens'],              plan: 'monthly',     method: 'ach' },
  { students: ['Thea Bailey'],                                  plan: 'semi-annual', method: 'check' },
  { students: ['Ruby Park'],                                    plan: 'monthly',     method: 'cash' },
  { students: ['Samantha Simpson'],                             plan: 'monthly',     method: 'check' },
  { students: ['Zenya Truskin'],                                plan: 'annual',      method: 'check' },
  { students: ['Molly McDonald'],                               plan: 'monthly',     method: 'ach' },
  { students: ['Scarlett Bollinger'],                           plan: 'monthly',     method: 'check' },
  { students: ['Niko Skulski'],                                 plan: 'monthly',     method: 'check' },
  { students: ['Gregorio Canosa'],                              plan: 'annual',      method: 'check' },
  { students: ['Luca D\'Agostino', 'Kiera D\'Agostino'],        plan: 'monthly',     method: 'check' },
  { students: ['Cameron Sutter'],                               plan: 'monthly',     method: 'check' },
  { students: ['Ava Allen'],                                    plan: 'monthly',     method: 'check' },
  { students: ['Blake Williams'],                               plan: 'monthly',     method: 'check' },
  { students: ['Matilda O\'Brien'],                             plan: 'monthly',     method: 'ach' },
  { students: ['Maria Brezicha'],                               plan: 'semi-annual', method: 'check' },
  { students: ['Zachary Salvadore'],                            plan: 'semi-annual', method: 'check' },
  { students: ['Finnley Ware'],                                 plan: 'monthly',     method: 'ach' },
  { students: ['Maahi Suthar', 'Vihaan Suthar'],                plan: 'monthly',     method: 'ach' },
  { students: ['Madison Korzeniowski', 'Natalie Korzeniowski'], plan: 'annual',      method: 'check' },
  { students: ['Zara Alizai'],                                  plan: 'monthly',     method: 'ach' },
  { students: ['Tatum Piotti'],                                 plan: 'annual',      method: 'check' },
  { students: ['Ryan Sobotta', 'Abigail Sobotta'],              plan: 'annual',      method: 'check' },
  { students: ['Luca Giannascoli'],                             plan: 'annual',      method: 'check' },
];

// ── Schedule defaults ───────────────────────────────────────────────
// Without explicit per-student schedule data, default to "5 Days, Full Day"
// which is MCH's most common configuration. The grid display_name is the
// natural key we look up by.
const DEFAULT_GRID_BY_PROGRAM = {
  'Young Community': 'YC — 5 Days, Full Day (9am–2:45pm)',  // wait — this is wrong; see below
  'Primary':         'Primary — 5 Days, Full Day',
  'Kindergarten':    'Kindergarten — 5 Full Days (8:30am–3:15pm)',
};
// Display-name lookups need to match exactly; using the wrong YC display
// would silently 0-match. Pick the highest tier YC grid (5 Days Full):
const YC_5_FULL_DISPLAY = 'YC — 5 Days, Full Day';
DEFAULT_GRID_BY_PROGRAM['Young Community'] = YC_5_FULL_DISPLAY;

// Classroom → program mapping inferred from MCH's age distribution.
// (See seed analysis: Rose+Buttercup avg age 1.7-1.8, Tulip+Sunflower avg 3.7-3.9.)
// Kids 5+ at the start of the school year override to Kindergarten.
function programFromClassroom(classroom, dob) {
  const c = String(classroom ?? '').toLowerCase();
  const dobDate = dob ? new Date(dob) : null;
  const ageAtSep2026 = dobDate
    ? (new Date('2026-09-01').getTime() - dobDate.getTime()) / (365.25 * 24 * 60 * 60 * 1000)
    : null;
  // Kindergarten gate: any kid who turns 5 before Sep 1 lands in K
  // regardless of classroom. (MCH's K is the oldest age band.)
  if (ageAtSep2026 !== null && ageAtSep2026 >= 5) return 'Kindergarten';
  if (c === 'rose' || c === 'buttercup') return 'Young Community';
  if (c === 'tulip' || c === 'sunflower') return 'Primary';
  // No classroom on file — fall back to age-based bucket.
  if (ageAtSep2026 !== null && ageAtSep2026 < 3) return 'Young Community';
  return 'Primary';
}

// ── Name aliases ────────────────────────────────────────────────────
// Survey responses sometimes use the parent-provided spelling, while the
// DB has data-entry spellings (often from an Excel/CSV import). These
// aliases let the survey-side name find the DB-side record without us
// having to mass-fix the DB or run fuzzy matching.
//
// Format: lower-cased "survey first last" → "db first last"
const NAME_ALIASES = {
  'vihaan suthar':         'vlhaan suthar',         // DB typo "Vlhaan"
  'madison korzeniowski':  'madison koreniowski',   // DB missing second "z"
};

// ── Helpers ─────────────────────────────────────────────────────────
const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ');

async function findStudent(rawName) {
  let n = norm(rawName);
  if (NAME_ALIASES[n]) n = NAME_ALIASES[n];
  const parts = n.split(' ');
  const first = parts[0];
  const last = parts.length > 1 ? parts.slice(1).join(' ') : null;

  // Try exact first+last match first
  if (last) {
    const r = await pool.query(
      `SELECT id, family_id, first_name, last_name, date_of_birth, metadata->>'classroom' AS classroom
         FROM students
        WHERE school_id = $1
          AND LOWER(first_name) = $2
          AND LOWER(REPLACE(last_name, '''', '''')) = $3
          AND status = 'active'`,
      [MCH_SCHOOL_ID, first, last],
    );
    if (r.rowCount > 0) return { match: r.rows[0], strategy: 'first+last' };
  }

  // Fall back to first-name only (warn if multiple)
  const r = await pool.query(
    `SELECT id, family_id, first_name, last_name, date_of_birth, metadata->>'classroom' AS classroom
       FROM students
      WHERE school_id = $1 AND LOWER(first_name) = $2 AND status = 'active'`,
    [MCH_SCHOOL_ID, first],
  );
  if (r.rowCount === 1) return { match: r.rows[0], strategy: 'first-only' };
  if (r.rowCount > 1) return { match: null, strategy: 'ambiguous', candidates: r.rows };
  return { match: null, strategy: 'not-found' };
}

async function upsertEnrollment(student, plan, gridId, gridAnnualCents, scheduleTemplate) {
  const discountBp = plan.discount_basis_points;
  const totalAnnual = Math.round(gridAnnualCents * (1 - discountBp / 10000));

  const existing = await pool.query(
    `SELECT id FROM family_tuition_enrollments
      WHERE school_id = $1 AND family_id = $2 AND student_id = $3 AND academic_year = $4`,
    [MCH_SCHOOL_ID, student.family_id, student.id, ACADEMIC_YEAR],
  );

  if (existing.rowCount > 0) {
    await pool.query(
      `UPDATE family_tuition_enrollments
          SET tuition_grid_id = $1, payment_plan_id = $2,
              annual_tuition_cents = $3, plan_discount_basis_points = $4,
              total_annual_cents = $5, installment_count = $6,
              schedule = $7::jsonb, status = 'active', updated_at = now()
        WHERE id = $8`,
      [gridId, plan.id, gridAnnualCents, discountBp, totalAnnual,
       plan.installment_count, JSON.stringify(scheduleTemplate), existing.rows[0].id],
    );
    return { action: 'updated', total: totalAnnual };
  }

  await pool.query(
    `INSERT INTO family_tuition_enrollments
       (school_id, family_id, student_id, academic_year,
        tuition_grid_id, payment_plan_id,
        annual_tuition_cents, plan_discount_basis_points, addons,
        total_annual_cents, installment_count, schedule,
        status, internal_note, created_by_email)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '[]'::jsonb,
             $9, $10, $11::jsonb, 'active',
             'Imported from 2026-27 Tuition Survey', 'mch-import@growthsuite.local')`,
    [MCH_SCHOOL_ID, student.family_id, student.id, ACADEMIC_YEAR,
     gridId, plan.id, gridAnnualCents, discountBp,
     totalAnnual, plan.installment_count, JSON.stringify(scheduleTemplate)],
  );
  return { action: 'created', total: totalAnnual };
}

async function main() {
  console.log(`Importing MCH tuition survey responses${args.dryRun ? ' (DRY RUN — no writes)' : ''}\n`);

  // Load grids by display name
  const { rows: grids } = await pool.query(
    `SELECT id, display_name, program, grade_level, annual_tuition_cents
       FROM tuition_grids
      WHERE school_id = $1 AND academic_year = $2 AND is_active = true`,
    [MCH_SCHOOL_ID, ACADEMIC_YEAR],
  );
  const gridByDisplay = new Map(grids.map((g) => [g.display_name, g]));
  const gridByGradeLevel = new Map();
  for (const g of grids) {
    if (!gridByGradeLevel.has(g.grade_level)) gridByGradeLevel.set(g.grade_level, []);
    gridByGradeLevel.get(g.grade_level).push(g);
  }
  console.log(`Loaded ${grids.length} tuition grids.`);

  // Load plans by slug
  const { rows: plans } = await pool.query(
    `SELECT id, slug, display_name, installment_count, discount_basis_points, schedule_template
       FROM payment_plans WHERE school_id = $1 AND is_active = true`,
    [MCH_SCHOOL_ID],
  );
  const planBySlug = new Map(plans.map((p) => [p.slug, p]));
  console.log(`Loaded ${plans.length} payment plans.\n`);

  let created = 0, updated = 0, skipped = 0, unmatched = 0;
  const unmatchedNames = [];

  for (const resp of SURVEY_RESPONSES) {
    const plan = planBySlug.get(resp.plan);
    if (!plan) {
      console.log(`  ⊘ plan ${resp.plan} missing in DB — skipping this row`);
      skipped++; continue;
    }

    for (const name of resp.students) {
      const result = await findStudent(name);
      if (!result.match) {
        unmatched++;
        unmatchedNames.push(`${name} (${result.strategy})`);
        console.log(`  ✗ no match: ${name.padEnd(28)} (${result.strategy})`);
        continue;
      }
      const stu = result.match;
      const program = programFromClassroom(stu.classroom, stu.date_of_birth);
      const gridDisplay = DEFAULT_GRID_BY_PROGRAM[program];
      const grid = gridByDisplay.get(gridDisplay);
      if (!grid) {
        console.log(`  ⊘ no grid for "${gridDisplay}" — skipping ${name}`);
        skipped++; continue;
      }

      if (args.dryRun) {
        console.log(`  • DRY: ${name.padEnd(28)} stu:${stu.first_name} ${stu.last_name}  classroom:${stu.classroom || '-'}  → ${program} / ${grid.display_name}  plan:${plan.slug}  → $${(grid.annual_tuition_cents * (1 - plan.discount_basis_points/10000) / 100).toFixed(2)}/yr (${plan.installment_count} installments)`);
        continue;
      }

      const upsert = await upsertEnrollment(stu, plan, grid.id, grid.annual_tuition_cents, plan.schedule_template);
      if (upsert.action === 'created') created++;
      if (upsert.action === 'updated') updated++;
      const annualDollars = (upsert.total / 100).toFixed(0);
      console.log(`  ${upsert.action === 'created' ? '✓' : '↻'} ${name.padEnd(28)} ${stu.classroom || '?'.padEnd(10)} → ${program.padEnd(15)} ${plan.slug.padEnd(11)} $${annualDollars}/yr`);
    }
  }

  console.log(`\nDone. ${created} created, ${updated} updated, ${skipped} skipped, ${unmatched} unmatched`);
  if (unmatchedNames.length > 0) {
    console.log('\nUnmatched names (manual review needed):');
    for (const u of unmatchedNames) console.log(`  • ${u}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => pool.end());

function parseArgs(argv) {
  return { dryRun: argv.includes('--dry-run') };
}
