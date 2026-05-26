// Provision DGM classroom + program dashboards with ONE widget: the
// rich Student Roster. Teachers slice via the filter row (allergies-
// only, IEP/504-only, lunch-only, today's-attendance, etc.) and click
// any row to expand the family accordion — which surfaces parents,
// per-student health (allergy + special instructions + IEP/504),
// medical notes, and pickup info inline. One single page, one set of
// filters, no scrolling past sections you don't care about.
//
// Filtering pre-narrow:
//   classroom-N hubs    → default_homeroom_filter = "Classroom N"
//   program-NN hubs     → default_program_filter  = "<program label>"
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

// Columns visible on a teacher's roster by default. Allergy +
// special-instructions sit next to each other for at-a-glance scanning.
// Family + documents stay enabled — opening the accordion is the way
// to get every detail without leaving the page.
//
// `status` is intentionally OFF: every kid on a classroom roster is
// enrolled by definition (the roster query already filters), so the
// pill was just visual noise that ate a column of width.
const TEACHER_ROSTER_COLUMNS = [
  'student',
  'gender_age',
  'program',
  'homeroom',
  'schedule',
  'allergy',
  'special_instructions',
  'iep_504',
  'lunch',
  'attendance',
  'documents',  // inline cell — click chip to view IEP/504/health docs for that student
  'family',
];

// Filter row available to the teacher. Allergies/IEP/lunch toggles
// give them one-click slicing without leaving the roster.
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

  // Stable instance id so re-running doesn't churn the id for the
  // unchanged single widget.
  const id = (widgetId) =>
    crypto.createHash('sha1').update(`${slug}|${widgetId}`).digest('hex').slice(0, 32);

  // For the StudentRosterRich, populate the default filter that
  // pre-narrows the roster without the operator picking a filter.
  // The widget honors `default_homeroom_filter` for classroom hubs
  // and `default_program_filter` for program hubs.
  const rosterDefaults = isProgramHub
    ? { default_program_filter: filter.program_filter }
    : { default_homeroom_filter: filter.classroom_filter };

  return [
    {
      widget_id: 'student_roster_rich',
      instance_id: id('student_roster_rich'),
      // Full page — the roster + its accordion expand to fill the iframe.
      position: { x: 0, y: 0, w: 12, h: 32 },
      config: {
        page_size: 100,
        enable_views: ['list', 'grid', 'allergies'],
        shown_columns: TEACHER_ROSTER_COLUMNS,
        shown_filters: TEACHER_ROSTER_FILTERS,
        ...rosterDefaults,
        drilldown_dashboard_slug: 'family-hub',
        documents_audience: 'teacher',  // hide admin-only docs
      },
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
