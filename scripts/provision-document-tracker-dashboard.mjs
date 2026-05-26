// Provisions a "Document Tracker" dashboard for a given school.
//
// This is the rich, full-page family × form completion grid (the
// `document_tracker` widget). It auto-refreshes every 60s and lets
// office staff drill into any family from the grid.
//
// Mirrors DGM's document-tracker dashboard (position 0). Idempotent
// — re-running just refreshes the layout config.
//
// USAGE:
//   node scripts/provision-document-tracker-dashboard.mjs --school-id <uuid>
//   node scripts/provision-document-tracker-dashboard.mjs --location <ghl_id>

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

const schoolIdArg = arg('school-id');
const locationArg = arg('location');

let schoolId;
if (schoolIdArg) {
  schoolId = schoolIdArg;
} else if (locationArg) {
  const { rows } = await pool.query(
    `SELECT id FROM schools WHERE ghl_location_id = $1`, [locationArg],
  );
  if (rows.length === 0) {
    console.error(`No school with location_id ${locationArg}`); process.exit(1);
  }
  schoolId = rows[0].id;
} else {
  console.error('Usage: --school-id <uuid> | --location <ghl_id>');
  process.exit(2);
}

// Mirrors DGM's document-tracker layout exactly.
const layout = [{
  instance_id: randomUUID(),
  widget_id: 'document_tracker',
  config: {
    auto_refresh_ms: 60000,
    drilldown_dashboard_slug: 'family-hub',
  },
  position: { x: 0, y: 0, w: 12, h: 12 },
}];

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
    'document-tracker',
    'Document Tracker',
    'Track form and document completion across all families.',
    JSON.stringify(layout),
    0, // top of nav, matching DGM
  ],
);

const { rows } = await pool.query(
  `SELECT id, dashboard_slug, display_name, position FROM school_dashboards
    WHERE school_id = $1 AND dashboard_slug = 'document-tracker'`,
  [schoolId],
);
console.log('Provisioned:', rows[0]);
await pool.end();
