// Creates (or refreshes) an "Enrollment Hub" dashboard for Wooster — same
// rich widget DGM uses, scoped to ACTUALLY enrolled students only.
//
// Why only_enrolled=true:
//   Wooster's data layer doesn't cleanly separate inquiries / prospects
//   from enrolled families — the only upstream signal is a GHL tag, and
//   tag membership could drift over time. Configuring the widget with
//   only_enrolled=true forces the SQL roster to enrollments.status =
//   'enrolled' so the hub never surfaces an "interested in 1st grade"
//   lead next to a current student.
//
// Why we picked these filters / columns:
//   - status: still shown so if Wooster ever has non-enrolled rows (e.g.
//     a withdrawn student keeps an enrollments row) it surfaces visibly
//   - program: the canonical Wooster breakdown (Lower Elementary, Upper
//     Elementary, Children's House, Middle School, etc.) — driven by
//     GHL field 'select_the_program_this_child_will_attend'
//   - year: pinned to 2026-27 via config but the filter is still
//     available so future years are easy to flip
//   - homeroom/schedule/teacher: hidden — Wooster doesn't track these
//     in GHL yet. The widget knows how to render them; we'll surface
//     them later if Wooster captures the data.
//
// Idempotent.

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

const WOOSTER_SCHOOL_ID = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
const SCHOOL_ID = process.env.SCHOOL_ID || process.argv[2] || WOOSTER_SCHOOL_ID;

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
      academic_year: '2026-27',
      // SQL-level guarantee: only students with enrollments.status =
      // 'enrolled' appear. See widget config.ts for why.
      only_enrolled: true,
      shown_filters: ['program', 'homeroom', 'year'],
      shown_columns: [
        'student', 'dob', 'age', 'homeroom', 'program', 'year', 'family',
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
      'Currently enrolled students for 2026-27, broken down by Montessori program. '
      + 'Only shows families with active enrollment — inquiries and prospects are excluded.';

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
      console.log(`Updated Enrollment Hub dashboard (id=${dashboardId}).`);
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
      console.log(`Created Enrollment Hub dashboard (id=${dashboardId}).`);
    }

    console.log(`Open at: /school/${SCHOOL_ID}/${slug}`);
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
