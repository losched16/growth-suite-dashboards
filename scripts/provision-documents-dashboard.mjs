// Provisions a "Documents" dashboard for a given school. Idempotent.
//
// USAGE:
//   node scripts/provision-documents-dashboard.mjs --school-id <uuid>
//   node scripts/provision-documents-dashboard.mjs --location <ghl_id>

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

const layout = [{
  instance_id: randomUUID(),
  widget_id: 'student_documents_browser',
  config: { page_size: 100 },
  position: { x: 0, y: 0, w: 12, h: 16 },
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
    'documents',
    'Documents',
    'Searchable library of every document uploaded across the school. Upload via the button at the top.',
    JSON.stringify(layout),
    125, // between Attendance (120) and Portal Forms (130)
  ],
);

console.log(`Documents dashboard provisioned for school ${schoolId}.`);
await pool.end();
