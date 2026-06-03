// Creates (or refreshes) the "Enrollment Hub" dashboard for Shrewsbury
// Montessori. Same rich EnrollmentHubTable widget DGM + Wooster use,
// configured for Shrewsbury's current data shape.
//
// What's different from the DGM / Wooster setup:
//   - academic_year pinned to 2025-26 (Shrewsbury hasn't loaded the
//     2026-27 cycle yet). Easy to flip when they do — re-run with
//     SHREWSBURY_ACADEMIC_YEAR=2026-27 once they have data.
//   - only_enrolled = false. Every Shrewsbury record today is
//     enrollments.status='inquiry' — they're an admissions pipeline,
//     not a current student roster. Showing only_enrolled would
//     surface zero rows. As enrollments convert, the same dashboard
//     keeps working — operators can filter to 'enrolled' on-screen.
//   - Trimmed column set. Shrewsbury hasn't populated program,
//     homeroom, classroom, schedule, or started_at yet, so those
//     columns would all be em-dashes — wasted width. Re-add via the
//     dashboard's settings (or this script) when the data lands.
//   - Status filter shown by default — operators will want to slice
//     pipeline stage early and often.
//
// Idempotent. Re-run any time:
//   node scripts/provision-shrewsbury-enrollment-hub.mjs

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

const SHREWSBURY_SCHOOL_ID = 'bf5e15d7-c0df-4ac6-9b6f-ededee90b02a';
const SCHOOL_ID = process.env.SCHOOL_ID || process.argv[2] || SHREWSBURY_SCHOOL_ID;
const ACADEMIC_YEAR = process.env.SHREWSBURY_ACADEMIC_YEAR || '2025-26';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const ENROLLMENT_HUB_LAYOUT = [
  {
    widget_id: 'enrollment_hub_table',
    instance_id: 'enrollment-hub-default',
    position: { x: 0, y: 0, w: 12, h: 14 },
    config: {
      academic_year: ACADEMIC_YEAR,
      // false today: Shrewsbury's pipeline is all 'inquiry'. As real
      // enrollments come in, the operator can filter to status=enrolled
      // on the page itself or this can be flipped via re-run.
      only_enrolled: false,
      shown_filters: ['status', 'year'],
      shown_columns: [
        'student', 'dob', 'age', 'status', 'family',
      ],
      show_stat_cards: true,
      show_breakdowns: true,
      drilldown_dashboard_slug: 'family-hub',
    },
  },
];

async function main() {
  const c = await pool.connect();
  try {
    const slug = 'enrollment-hub';
    const display = 'Enrollment Hub';
    const description =
      `Admissions + enrollment pipeline for ${ACADEMIC_YEAR}. `
      + 'Stat cards roll up totals; the table below is searchable + sortable. '
      + 'As inquiries convert to enrolled students, use the status filter to slice the pipeline.';

    const existing = await c.query(
      `SELECT id FROM school_dashboards WHERE school_id = $1 AND dashboard_slug = $2`,
      [SCHOOL_ID, slug],
    );

    let dashboardId;
    if (existing.rows[0]) {
      await c.query(
        `UPDATE school_dashboards
            SET display_name = $1, description = $2, layout = $3::jsonb,
                is_enabled = true, updated_at = now()
          WHERE id = $4`,
        [display, description, JSON.stringify(ENROLLMENT_HUB_LAYOUT), existing.rows[0].id],
      );
      dashboardId = existing.rows[0].id;
      console.log(`✓ Updated Shrewsbury Enrollment Hub (id=${dashboardId}, year=${ACADEMIC_YEAR}).`);
    } else {
      const ins = await c.query(
        `INSERT INTO school_dashboards
           (school_id, dashboard_slug, display_name, description, layout, is_enabled, position)
         VALUES ($1, $2, $3, $4, $5::jsonb, true,
                 COALESCE((SELECT MAX(position) + 10 FROM school_dashboards WHERE school_id = $1), 100))
         RETURNING id`,
        [SCHOOL_ID, slug, display, description, JSON.stringify(ENROLLMENT_HUB_LAYOUT)],
      );
      dashboardId = ins.rows[0].id;
      console.log(`✓ Created Shrewsbury Enrollment Hub (id=${dashboardId}, year=${ACADEMIC_YEAR}).`);
    }

    // Quick sanity check — how many rows match the current config?
    const cnt = await c.query(
      `SELECT COUNT(*)::int AS n
         FROM students s
         JOIN enrollments e ON e.student_id = s.id
        WHERE s.school_id = $1 AND e.academic_year = $2`,
      [SCHOOL_ID, ACADEMIC_YEAR],
    );
    console.log(`  Matched ${cnt.rows[0].n} students with enrollments for ${ACADEMIC_YEAR}.`);
    console.log(`  Open at: /school/<locationId>/${slug}`);
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
