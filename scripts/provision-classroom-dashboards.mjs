// Provisions a private per-classroom dashboard for each classroom on
// a given school. One dashboard per classroom, slug = `classroom-{slug}`.
// Each dashboard contains:
//   1. Student Roster (filtered to the classroom)
//   2. Attendance (filtered to the classroom)
//   3. Hot Lunch
//   4. Parent Contacts
//   5. Pickup Restrictions
//
// Idempotent. Re-running just replays the layouts (so we can iterate
// on the design without dup-creating dashboards).
//
// USAGE:
//   node scripts/provision-classroom-dashboards.mjs --school-id <uuid>
//   node scripts/provision-classroom-dashboards.mjs --location <ghl_id>

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

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

let schoolId = arg('school-id');
let locationId = arg('location');
if (!schoolId && locationId) {
  const { rows } = await pool.query(
    `SELECT id, ghl_location_id FROM schools WHERE ghl_location_id = $1`, [locationId]);
  if (rows.length === 0) { console.error(`No school with location ${locationId}`); process.exit(1); }
  schoolId = rows[0].id;
}
if (!schoolId) {
  console.error('Usage: --school-id <uuid> | --location <ghl_id>');
  process.exit(2);
}

// Resolve location for output URL generation.
if (!locationId) {
  const { rows } = await pool.query(`SELECT ghl_location_id FROM schools WHERE id = $1`, [schoolId]);
  locationId = rows[0]?.ghl_location_id ?? null;
}

// Discover classrooms: union of the classrooms table + distinct
// student.metadata.homeroom values. We use the homeroom string as the
// CANONICAL filter value (that's what the widgets all read from).
const { rows: rawClassrooms } = await pool.query(
  `WITH homerooms AS (
     SELECT DISTINCT
       COALESCE(metadata->>'homeroom', metadata->>'classroom_name') AS name,
       COUNT(*)::int AS student_count
     FROM students WHERE school_id = $1 AND status = 'active'
       AND COALESCE(metadata->>'homeroom', metadata->>'classroom_name') IS NOT NULL
     GROUP BY 1
   )
   SELECT h.name, h.student_count
     FROM homerooms h
    ORDER BY h.name`,
  [schoolId],
);

if (rawClassrooms.length === 0) {
  console.error(`No classrooms with active students found for school ${schoolId}.`);
  process.exit(1);
}

console.log(`Provisioning per-classroom dashboards for school ${schoolId} (${rawClassrooms.length} classrooms):`);
console.log();

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const created = [];
for (const [i, c] of rawClassrooms.entries()) {
  // If the classroom name already starts with "classroom", keep the
  // slug as-is. Otherwise add the prefix so the URLs are predictable.
  const baseSlug = slugify(c.name);
  const slug = /^classroom-/.test(baseSlug) ? baseSlug : `classroom-${baseSlug}`;
  const displayName = c.name;
  const layout = [
    {
      instance_id: randomUUID(),
      widget_id: 'student_roster_rich',
      config: {
        shown_filters: ['program', 'schedule', 'allergies_only', 'iep_504_only'],
        shown_columns: ['student', 'gender_age', 'program', 'homeroom', 'schedule', 'status', 'allergy', 'iep_504', 'documents', 'family'],
        enable_views: ['list', 'grid', 'allergies'],
        page_size: 100,
        drilldown_dashboard_slug: 'family-hub',
        default_homeroom_filter: c.name,
      },
      position: { x: 0, y: 0, w: 12, h: 10 },
    },
    {
      instance_id: randomUUID(),
      widget_id: 'attendance_dashboard',
      config: {
        timezone: 'America/Phoenix',
        default_view: 'today',
        default_classroom_filter: c.name,
      },
      position: { x: 0, y: 10, w: 12, h: 14 },
    },
    {
      instance_id: randomUUID(),
      widget_id: 'classroom_hot_lunch',
      config: { classroom_filter: c.name },
      position: { x: 0, y: 24, w: 6, h: 8 },
    },
    {
      instance_id: randomUUID(),
      widget_id: 'classroom_parent_contacts',
      config: { classroom_filter: c.name },
      position: { x: 6, y: 24, w: 6, h: 8 },
    },
    {
      instance_id: randomUUID(),
      widget_id: 'classroom_pickup_restrictions',
      config: { classroom_filter: c.name },
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
      schoolId,
      slug,
      `${displayName} Hub`,
      `Private classroom dashboard for ${displayName} — students, attendance, hot lunch, parent contacts, pickup restrictions.`,
      JSON.stringify(layout),
      200 + i, // sit at the end of the sidebar order so the public dashboards stay on top
    ],
  );
  created.push({ slug, name: displayName, student_count: c.student_count });
  console.log(`  ✓ ${displayName.padEnd(22)} → /school/${locationId}/${slug}  (${c.student_count} students)`);
}

console.log();
console.log('Done. Direct URLs (each can be embedded as a private dashboard):');
console.log();
const base = 'https://growth-suite-dashboards.vercel.app';
for (const c of created) {
  console.log(`  ${c.name.padEnd(22)} ${base}/school/${locationId}/${c.slug}?chrome=none`);
}

await pool.end();
