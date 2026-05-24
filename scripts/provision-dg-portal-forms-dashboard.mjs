// Provision a "Portal Forms" dashboard for DG containing the two
// new widgets (completion grid + submissions inbox).
//
// Idempotent: ON CONFLICT (school_id, dashboard_slug) DO UPDATE.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

const envText = readFileSync(join(projectRoot, '.env.local'), 'utf8');
for (const line of envText.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq).trim();
  const value = trimmed.slice(eq + 1).trim();
  if (!process.env[key]) process.env[key] = value;
}

const args = parseArgs(process.argv.slice(2));
if (!args.schoolId) {
  console.error('Usage: node scripts/provision-dg-portal-forms-dashboard.mjs --school-id <uuid>');
  process.exit(2);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  const layout = [
    {
      instance_id: randomUUID(),
      widget_id: 'portal_forms_inbox',
      config: {
        limit: 30,
        academic_year: '2025-26',
        category_filter: '',
        status_filter: 'all',
      },
      position: { x: 0, y: 0, w: 12, h: 6 },
    },
    {
      instance_id: randomUUID(),
      widget_id: 'portal_forms_completion_grid',
      config: {
        categories: [],
        academic_year: '2025-26',
        only_active: true,
        status_filter: 'enrolled',
      },
      position: { x: 0, y: 6, w: 12, h: 10 },
    },
  ];

  await pool.query(
    `INSERT INTO school_dashboards
       (school_id, dashboard_slug, display_name, description, layout, is_enabled, position)
     VALUES ($1, $2, $3, $4, $5::jsonb, true, $6)
     ON CONFLICT (school_id, dashboard_slug) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       description = EXCLUDED.description,
       layout = EXCLUDED.layout,
       is_enabled = true,
       position = EXCLUDED.position,
       updated_at = now()`,
    [
      args.schoolId,
      'portal-forms',
      'Portal Forms',
      'Native parent-portal form submissions: completion tracker + recent submissions.',
      JSON.stringify(layout),
      130, // after attendance (120)
    ],
  );

  const { rows } = await pool.query(
    `SELECT id, dashboard_slug, display_name, position FROM school_dashboards
     WHERE school_id = $1 AND dashboard_slug = 'portal-forms'`,
    [args.schoolId],
  );
  console.log('Provisioned:', rows[0]);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => pool.end());

function parseArgs(argv) {
  const out = { schoolId: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--school-id') out.schoolId = argv[++i];
  }
  return out;
}
