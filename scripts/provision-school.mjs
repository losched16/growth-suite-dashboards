// Provisions a brand-new school in Growth Suite:
//   1. Creates the `schools` row (encrypting the PIT)
//   2. Provisions the standard core dashboards (Family Hub + Student
//      Roster). These mirror the configs we use for Desert Garden.
//
// Idempotent end-to-end:
//   - schools insert uses ON CONFLICT (ghl_location_id) DO UPDATE
//     (so re-running re-encrypts/refreshes the PIT cleanly).
//   - dashboard inserts use ON CONFLICT (school_id, dashboard_slug)
//     DO UPDATE (so re-running just replays the layout config).
//
// USAGE:
//   node scripts/provision-school.mjs \
//     --name "Media Children's House" \
//     --location 4oZpFL4j3zZP3Lk4T0Ap \
//     --pit pit-026c8718-6c79-4d37-8710-215be7cdb0d9
//
// You can also add --no-dashboards if you JUST want the school row,
// or --dashboards-only if the school already exists and you only want
// the dashboards refreshed.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// Load .env.local without an extra dep.
const envText = readFileSync(join(projectRoot, '.env.local'), 'utf8');
for (const line of envText.split('\n')) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('='); if (eq === -1) continue;
  if (!process.env[t.slice(0, eq).trim()]) process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
}

// ── Arg parsing ──────────────────────────────────────────────────────
function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}

const SCHOOL_NAME      = arg('name');
const LOCATION_ID      = arg('location');
const PIT              = arg('pit');
const SKIP_DASHBOARDS  = flag('no-dashboards');
const DASHBOARDS_ONLY  = flag('dashboards-only');

if ((!DASHBOARDS_ONLY && (!SCHOOL_NAME || !LOCATION_ID || !PIT))
    || (DASHBOARDS_ONLY && !LOCATION_ID)) {
  console.error([
    'Usage:',
    '  node scripts/provision-school.mjs \\',
    '    --name "<school name>" --location <ghl_location_id> --pit <pit_token>',
    '',
    'Flags:',
    '  --no-dashboards      Skip dashboard provisioning, only create the schools row.',
    '  --dashboards-only    Skip schools row, only (re)provision dashboards. Requires --location.',
  ].join('\n'));
  process.exit(2);
}

// ── AES-256-GCM encryption helper (mirrors lib/crypto.ts) ────────────
const ALG = 'aes-256-gcm';
const IV_BYTES = 12;

function loadKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error('ENCRYPTION_KEY env var is required');
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error(`ENCRYPTION_KEY must decode to 32 bytes (got ${buf.length})`);
  }
  return buf;
}
function encryptPit(plaintext) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALG, loadKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext, iv, tag };
}

// ── Dashboard layouts (mirrors DGM's exact config) ───────────────────
function familyHubLayout() {
  return [{
    instance_id: crypto.randomUUID(),
    widget_id: 'family_hub_table',
    config: {
      page_size: 50,
      shown_columns: ['family', 'phone', 'students', 'enrollment', 'payment_plan', 'total_tuition', 'active'],
      shown_filters: ['family_status', 'enrollment_status', 'program', 'payment_plan'],
      show_stat_cards: true,
      drilldown_dashboard_slug: 'family-hub',
    },
    position: { x: 0, y: 0, w: 12, h: 12 },
  }];
}

function studentRosterLayout() {
  return [{
    instance_id: crypto.randomUUID(),
    widget_id: 'student_roster_rich',
    config: {
      page_size: 100,
      enable_views: ['list', 'grid', 'allergies'],
      shown_columns: ['student', 'gender_age', 'program', 'homeroom', 'lead_teacher', 'schedule', 'status', 'allergy', 'iep_504', 'family'],
      shown_filters: ['program', 'homeroom', 'schedule', 'lead_teacher', 'allergies_only', 'iep_504_only'],
      drilldown_dashboard_slug: 'family-hub',
    },
    position: { x: 0, y: 0, w: 12, h: 12 },
  }];
}

// Each entry: { slug, name, description, position, layoutFn }
const CORE_DASHBOARDS = [
  {
    slug: 'family-hub',
    name: 'Family Hub',
    description: 'Browse families and drill into their full picture.',
    position: 1,
    layoutFn: familyHubLayout,
  },
  {
    slug: 'student-roster',
    name: 'Student Roster',
    description: 'Browse all students with filters.',
    position: 2,
    layoutFn: studentRosterLayout,
  },
];

// ── DB helpers ───────────────────────────────────────────────────────
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function upsertSchool({ name, locationId, pit }) {
  const { ciphertext, iv, tag } = encryptPit(pit);
  const { rows } = await pool.query(
    `INSERT INTO schools (name, ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (ghl_location_id) DO UPDATE SET
       name              = EXCLUDED.name,
       ghl_pit_encrypted = EXCLUDED.ghl_pit_encrypted,
       ghl_pit_iv        = EXCLUDED.ghl_pit_iv,
       ghl_pit_tag       = EXCLUDED.ghl_pit_tag,
       updated_at        = now()
     RETURNING id, name, ghl_location_id, created_at`,
    [name, locationId, ciphertext, iv, tag],
  );
  return rows[0];
}

async function resolveSchoolId(locationId) {
  const { rows } = await pool.query(
    `SELECT id, name FROM schools WHERE ghl_location_id = $1`,
    [locationId],
  );
  if (rows.length === 0) {
    throw new Error(`No school with location_id ${locationId}. Run without --dashboards-only first.`);
  }
  return rows[0];
}

async function upsertDashboard(schoolId, { slug, name, description, position, layoutFn }) {
  const layout = layoutFn();
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
    [schoolId, slug, name, description, JSON.stringify(layout), position],
  );
}

// ── Main ─────────────────────────────────────────────────────────────
try {
  let school;
  if (DASHBOARDS_ONLY) {
    school = await resolveSchoolId(LOCATION_ID);
    console.log(`Found existing school: ${school.name} (${school.id})`);
  } else {
    school = await upsertSchool({ name: SCHOOL_NAME, locationId: LOCATION_ID, pit: PIT });
    console.log(`School row provisioned: ${school.name} (${school.id})`);
  }

  if (!SKIP_DASHBOARDS) {
    console.log();
    console.log('Provisioning core dashboards:');
    for (const d of CORE_DASHBOARDS) {
      await upsertDashboard(school.id, d);
      console.log(`  + ${d.slug.padEnd(20)} "${d.name}"`);
    }
  }

  console.log();
  console.log('='.repeat(60));
  console.log(`  Done. ${SKIP_DASHBOARDS ? 'School only' : 'School + ' + CORE_DASHBOARDS.length + ' dashboards'}.`);
  console.log('  Embed URL (school iframe):');
  console.log(`    https://growth-suite-dashboards.vercel.app/school/${LOCATION_ID}`);
  console.log('='.repeat(60));
} catch (e) {
  console.error('FAILED:', e instanceof Error ? e.message : String(e));
  process.exit(1);
} finally {
  await pool.end();
}
