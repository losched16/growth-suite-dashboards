// Provisions program-scoped dashboards (Upper Elementary, MYHS) for
// schools where teacher groups span multiple classrooms.
//
// Same widget layout as the per-classroom dashboards, but every widget
// scopes by `metadata.program` instead of `metadata.homeroom`.
//
// USAGE:
//   node scripts/provision-program-dashboards.mjs --location <ghl_id>

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(join(__dirname, '..', '.env.local'), 'utf8');
for (const line of envText.split('\n')) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('='); if (eq === -1) continue;
  if (!process.env[t.slice(0, eq).trim()]) process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
}
function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const locationId = arg('location');
if (!locationId) {
  console.error('Usage: --location <ghl_id>');
  process.exit(2);
}

const { rows } = await pool.query(
  `SELECT id, ghl_location_id FROM schools WHERE ghl_location_id = $1`, [locationId]);
if (rows.length === 0) { console.error(`No school with location ${locationId}`); process.exit(1); }
const schoolId = rows[0].id;

// Discover programs from student metadata. Same idea as the per-
// classroom script, but bucketing by program. We then narrow to the
// programs that aren't already covered by classroom dashboards
// (i.e. programs whose students mostly lack a homeroom).
const { rows: programs } = await pool.query(
  `SELECT
     s.metadata->>'program'  AS program,
     COUNT(*)::int           AS total,
     SUM(CASE WHEN s.metadata->>'homeroom' IS NULL THEN 1 ELSE 0 END)::int AS no_homeroom
   FROM students s
   WHERE s.school_id = $1 AND s.status = 'active'
     AND s.metadata->>'program' IS NOT NULL
   GROUP BY 1 ORDER BY 1`,
  [schoolId],
);

// Pick programs that have a meaningful number of students missing a
// homeroom (>=10). These are the multi-classroom teacher groups (Upper
// El, MYHS) where the per-classroom dashboards wouldn't cover every
// student. Other programs (Primary, Toddler, etc.) get fully covered
// by their classroom dashboards.
const candidates = programs.filter((p) => p.no_homeroom >= 10);

if (candidates.length === 0) {
  console.log('No program-scoped dashboards needed — every program already covers via classroom dashboards.');
  await pool.end();
  process.exit(0);
}

console.log(`Provisioning ${candidates.length} program-scoped dashboard(s) for school ${schoolId}:\n`);

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const created = [];
for (const [i, p] of candidates.entries()) {
  const slug = `program-${slugify(p.program)}`;
  const layout = [
    {
      instance_id: randomUUID(),
      widget_id: 'student_roster_rich',
      config: {
        shown_filters: ['homeroom', 'schedule', 'allergies_only', 'iep_504_only'],
        shown_columns: ['student', 'gender_age', 'program', 'homeroom', 'schedule', 'status', 'allergy', 'iep_504', 'documents', 'family'],
        enable_views: ['list', 'grid', 'allergies'],
        page_size: 100,
        drilldown_dashboard_slug: 'family-hub',
        default_program_filter: p.program,
      },
      position: { x: 0, y: 0, w: 12, h: 10 },
    },
    {
      instance_id: randomUUID(),
      widget_id: 'attendance_dashboard',
      config: {
        timezone: 'America/Phoenix',
        default_view: 'today',
        default_program_filter: p.program,
      },
      position: { x: 0, y: 10, w: 12, h: 14 },
    },
    {
      instance_id: randomUUID(),
      widget_id: 'classroom_hot_lunch',
      config: { classroom_filter: '', program_filter: p.program },
      position: { x: 0, y: 24, w: 6, h: 8 },
    },
    {
      instance_id: randomUUID(),
      widget_id: 'classroom_parent_contacts',
      config: { classroom_filter: '', program_filter: p.program },
      position: { x: 6, y: 24, w: 6, h: 8 },
    },
    {
      instance_id: randomUUID(),
      widget_id: 'classroom_pickup_restrictions',
      config: { classroom_filter: '', program_filter: p.program },
      position: { x: 0, y: 32, w: 12, h: 6 },
    },
  ];
  await pool.query(
    `INSERT INTO school_dashboards
       (school_id, dashboard_slug, display_name, description, layout, is_enabled, position)
     VALUES ($1, $2, $3, $4, $5::jsonb, true, $6)
     ON CONFLICT (school_id, dashboard_slug) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       description  = EXCLUDED.description,
       layout       = EXCLUDED.layout,
       is_enabled   = true,
       position     = EXCLUDED.position,
       updated_at   = now()`,
    [
      schoolId, slug, `${p.program} Hub`,
      `Program-scoped dashboard for ${p.program} — students, attendance, hot lunch, parent contacts, pickup restrictions.`,
      JSON.stringify(layout),
      250 + i,
    ],
  );
  created.push({ slug, program: p.program, total: p.total });
  console.log(`  ✓ ${p.program.padEnd(22)} → /school/${locationId}/${slug}  (${p.total} students)`);
}

console.log('\nDone. Direct URLs:\n');
const base = 'https://growth-suite-dashboards.vercel.app';
for (const c of created) {
  console.log(`  ${c.program.padEnd(22)} ${base}/school/${locationId}/${c.slug}?chrome=none`);
}

await pool.end();
