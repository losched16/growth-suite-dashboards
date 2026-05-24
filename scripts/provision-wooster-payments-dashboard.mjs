// Creates (or refreshes) a "Payments" dashboard for Wooster with two
// widgets: PaymentsOverview (the new KPI panel) and FinancialAidQueue
// (so operators can see FA applications + use the new "Create FA
// discount" button without leaving the dashboard).
//
// Idempotent: looks up by school_id + dashboard_slug, updates layout
// if it already exists.

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

const PAYMENTS_LAYOUT = [
  {
    widget_id: 'payments_overview',
    instance_id: 'payments-overview-default',
    position: { x: 0, y: 0, w: 12, h: 8 },
    config: { failure_window_days: 14, recent_limit: 10 },
  },
  {
    widget_id: 'financial_aid_queue',
    instance_id: 'fa-queue-default',
    position: { x: 0, y: 8, w: 12, h: 16 },
    config: {
      default_recommended_award_floor: 1000,
      default_recommended_award_ceiling: 15000,
    },
  },
];

async function main() {
  const c = await pool.connect();
  try {
    const slug = 'payments';
    const display = 'Payments';
    const description = 'Daily payment KPIs, FA queue, and family billing operations.';

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
        [display, description, JSON.stringify(PAYMENTS_LAYOUT), existing.rows[0].id],
      );
      dashboardId = existing.rows[0].id;
      console.log(`Updated Payments dashboard (id=${dashboardId}).`);
    } else {
      const ins = await c.query(
        `INSERT INTO school_dashboards
           (school_id, dashboard_slug, display_name, description, layout, is_enabled, position)
         VALUES ($1, $2, $3, $4, $5::jsonb, true,
                 COALESCE((SELECT MAX(position) + 10 FROM school_dashboards WHERE school_id = $1), 100))
         RETURNING id`,
        [SCHOOL_ID, slug, display, description, JSON.stringify(PAYMENTS_LAYOUT)],
      );
      dashboardId = ins.rows[0].id;
      console.log(`Created Payments dashboard (id=${dashboardId}).`);
    }

    // Hide the legacy placeholder dashboard if one exists (the
    // `payment_dashboard_placeholder` widget gets superseded by the real
    // one). Soft-disable rather than delete so the operator can restore
    // if they want.
    const legacy = await c.query(
      `UPDATE school_dashboards
          SET is_enabled = false, updated_at = now()
        WHERE school_id = $1
          AND dashboard_slug IN ('tuition-dashboard', 'payment-dashboard-placeholder')
          AND layout::text LIKE '%payment_dashboard_placeholder%'
        RETURNING id, display_name`,
      [SCHOOL_ID],
    );
    if (legacy.rows.length > 0) {
      console.log(`Hid ${legacy.rows.length} legacy placeholder dashboard(s): ${legacy.rows.map((r) => r.display_name).join(', ')}`);
    }

    console.log(`Open at: /admin/${SCHOOL_ID}/dashboard/${dashboardId}`);
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
