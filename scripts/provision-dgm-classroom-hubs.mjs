// Provision the full teacher widget set on every DGM classroom +
// program dashboard. Each hub gets the same 5-widget layout so a
// teacher (or sub) opening their iframe sees the same structure:
//
//   1. ClassroomAllergies            — printable safety-critical list
//   2. StudentRosterRich             — full roster with allergy +
//                                       special-instructions columns
//   3. ClassroomHotLunch             — lunch selections + allergy column
//   4. ClassroomParentContacts       — parents with allergy badges
//   5. ClassroomPickupRestrictions   — "do not release to" list
//
// Filtering:
//   classroom-N hubs    → classroom_filter = "Classroom N"
//   program-NN hubs     → program_filter   = "<program label>"
//
// Idempotent. Re-running overwrites the layout — pass --dry-run to
// preview without writing.
//
// Usage:
//   node scripts/provision-dgm-classroom-hubs.mjs
//   node scripts/provision-dgm-classroom-hubs.mjs --dry-run

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// ── .env loader ─────────────────────────────────────────────────────
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
const DGM_SCHOOL_ID = 'cfa9030d-c8fe-49ae-a9e7-f1003844ec07';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Dashboard slug → filter config. Classroom hubs get classroom_filter
// (matches students.metadata.homeroom exactly); program hubs get
// program_filter (matches students.metadata.program).
const HUB_FILTERS = {
  'classroom-1':  { classroom_filter: 'Classroom 1'  },
  'classroom-2':  { classroom_filter: 'Classroom 2'  },
  'classroom-3':  { classroom_filter: 'Classroom 3'  },
  'classroom-4':  { classroom_filter: 'Classroom 4'  },
  'classroom-5':  { classroom_filter: 'Classroom 5'  },
  'classroom-6':  { classroom_filter: 'Classroom 6'  },
  'classroom-7':  { classroom_filter: 'Classroom 7'  },
  'classroom-8':  { classroom_filter: 'Classroom 8'  },
  'classroom-10': { classroom_filter: 'Classroom 10' },
  'classroom-11': { classroom_filter: 'Classroom 11' },
  'classroom-12': { classroom_filter: 'Classroom 12' },
  'program-05-upper-el': { program_filter: '05 Upper El' },
  'program-06-my-hs':    { program_filter: '06 MY/HS' },
};

// All columns the Student Roster should show on a teacher hub. The
// new special_instructions column is added between allergy + iep_504
// so they appear together. We keep family/documents off the teacher
// view to reduce noise (those live on the family-hub drill-down).
const TEACHER_ROSTER_COLUMNS = [
  'student',
  'gender_age',
  'program',
  'homeroom',
  'schedule',
  'status',
  'allergy',
  'special_instructions',
  'iep_504',
  'lunch',
  'attendance',
];

const TEACHER_ROSTER_FILTERS = [
  'program',
  'schedule',
  'attendance_status',
  'allergies_only',
  'iep_504_only',
  'lunch_only',
  'curbside_only',
];

function buildLayout(slug, filter) {
  const isProgramHub = !!filter.program_filter;
  const filterField = isProgramHub
    ? { program_filter: filter.program_filter, classroom_filter: '' }
    : { classroom_filter: filter.classroom_filter, program_filter: '' };

  // Stable instance ids so re-running doesn't churn ids for unchanged
  // widgets. Hash of (slug, widget_id) keeps them deterministic.
  const id = (widgetId) =>
    crypto.createHash('sha1').update(`${slug}|${widgetId}`).digest('hex').slice(0, 32);

  // For the StudentRosterRich, populate the "default" filter that
  // pre-narrows the roster without the operator picking a filter.
  // The widget honors `default_homeroom_filter` for classroom hubs
  // and `default_program_filter` for program hubs.
  const rosterDefaults = isProgramHub
    ? { default_program_filter: filter.program_filter }
    : { default_homeroom_filter: filter.classroom_filter };

  // Vertical stacking layout: each widget gets full width (w:12) and
  // a sensible row count. y positions accumulate so the grid editor
  // can re-arrange later without re-running this.
  return [
    {
      widget_id: 'classroom_allergies',
      instance_id: id('classroom_allergies'),
      position: { x: 0, y: 0, w: 12, h: 10 },
      config: {
        ...filterField,
        hide_students_without_concerns: false,
      },
    },
    {
      widget_id: 'student_roster_rich',
      instance_id: id('student_roster_rich'),
      position: { x: 0, y: 10, w: 12, h: 24 },
      config: {
        page_size: 100,
        enable_views: ['list', 'grid', 'allergies'],
        shown_columns: TEACHER_ROSTER_COLUMNS,
        shown_filters: TEACHER_ROSTER_FILTERS,
        ...rosterDefaults,
        drilldown_dashboard_slug: 'family-hub',
      },
    },
    {
      widget_id: 'classroom_hot_lunch',
      instance_id: id('classroom_hot_lunch'),
      position: { x: 0, y: 34, w: 12, h: 10 },
      config: filterField,
    },
    {
      widget_id: 'classroom_parent_contacts',
      instance_id: id('classroom_parent_contacts'),
      position: { x: 0, y: 44, w: 12, h: 12 },
      config: filterField,
    },
    {
      widget_id: 'classroom_pickup_restrictions',
      instance_id: id('classroom_pickup_restrictions'),
      position: { x: 0, y: 56, w: 12, h: 8 },
      config: filterField,
    },
  ];
}

async function main() {
  console.log(`Mode: ${args.dryRun ? 'DRY-RUN' : 'LIVE'}`);
  console.log(`School: Desert Garden Montessori (${DGM_SCHOOL_ID})\n`);

  let updated = 0, skipped = 0;
  for (const [slug, filter] of Object.entries(HUB_FILTERS)) {
    const layout = buildLayout(slug, filter);
    const filterLabel = filter.classroom_filter ?? filter.program_filter;

    if (args.dryRun) {
      console.log(`  + would update ${slug.padEnd(25)} (${filterLabel}) — ${layout.length} widgets`);
      continue;
    }

    const res = await pool.query(
      `UPDATE school_dashboards
          SET layout = $1::jsonb, updated_at = now()
        WHERE school_id = $2 AND dashboard_slug = $3
        RETURNING dashboard_slug`,
      [JSON.stringify(layout), DGM_SCHOOL_ID, slug],
    );
    if (res.rowCount === 0) {
      console.log(`  ⊝ dashboard not found: ${slug}`);
      skipped++;
    } else {
      console.log(`  ✓ updated ${slug.padEnd(25)} (${filterLabel}) — ${layout.length} widgets`);
      updated++;
    }
  }

  console.log('');
  if (args.dryRun) {
    console.log(`Dry-run complete. Would update ${Object.keys(HUB_FILTERS).length} dashboards.`);
  } else {
    console.log(`Done. ${updated} updated, ${skipped} not-found.`);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => pool.end());

function parseArgs(argv) {
  return { dryRun: argv.includes('--dry-run') };
}
