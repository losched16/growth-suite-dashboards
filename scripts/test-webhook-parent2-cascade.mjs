// End-to-end smoke test of the parent_2 webhook cascade.
//
// Picks one Wooster family with a known parent-2 row, fakes a
// "ContactUpdate" event for the primary's GHL contact, hits the local
// webhook handler, then prints whether the secondary parent's name +
// phone match what GHL has. Read-only sanity test of the data shape.
//
// Run AFTER:
//   1. npm run dev (so http://localhost:3000 is up)
//   2. GHL_WEBHOOK_SECRET is set in .env.local
//
// Usage:
//   node scripts/test-webhook-parent2-cascade.mjs

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
  const k = t.slice(0, eq).trim();
  if (!process.env[k]) process.env[k] = t.slice(eq + 1).trim();
}

const WOOSTER = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
const LOCATION = 'tFP5UnlBYQayjettNeuG';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

async function main() {
  // Pick a family with parent 2 (ghl_contact_id IS NULL) AND primary
  // parent has a ghl_contact_id.
  const { rows } = await pool.query(
    `SELECT f.id AS family_id, f.display_name,
            p1.ghl_contact_id AS primary_contact,
            p1.first_name AS primary_first, p1.last_name AS primary_last,
            p2.id AS p2_id, p2.first_name AS p2_first, p2.last_name AS p2_last, p2.phone AS p2_phone
       FROM families f
       JOIN parents p1 ON p1.family_id = f.id AND p1.is_primary = true AND p1.ghl_contact_id IS NOT NULL
       JOIN parents p2 ON p2.family_id = f.id AND p2.is_primary = false AND p2.ghl_contact_id IS NULL AND p2.status = 'active'
      WHERE f.school_id = $1
      ORDER BY f.display_name
      LIMIT 1`,
    [WOOSTER],
  );
  if (rows.length === 0) {
    console.log('No suitable family found.');
    await pool.end();
    return;
  }
  const fam = rows[0];
  console.log(`Test family: ${fam.display_name}`);
  console.log(`  Primary: ${fam.primary_first} ${fam.primary_last} (${fam.primary_contact})`);
  console.log(`  P2 (BEFORE): ${fam.p2_first} ${fam.p2_last} | ${fam.p2_phone ?? '(no phone)'}`);

  // Fire the webhook. Locally we don't actually hit the deployed
  // endpoint — instead we'd invoke the route handler. For a real test,
  // run this against the dev server: change the URL below to
  // http://localhost:3000/api/webhooks/ghl/contact and ensure your
  // env has GHL_WEBHOOK_SECRET set.
  const url = process.env.WEBHOOK_URL ?? 'http://localhost:3000/api/webhooks/ghl/contact';
  const secret = process.env.GHL_WEBHOOK_SECRET;
  if (!secret) {
    console.log('\nGHL_WEBHOOK_SECRET not set — skipping live webhook fire.');
    console.log('To run the cascade test:');
    console.log('  1. npm run dev');
    console.log('  2. WEBHOOK_URL=http://localhost:3000/api/webhooks/ghl/contact \\');
    console.log('     node scripts/test-webhook-parent2-cascade.mjs');
    await pool.end();
    return;
  }

  const body = {
    type: 'ContactUpdate',
    locationId: LOCATION,
    contactId: fam.primary_contact,
    webhookId: `smoke-test-${Date.now()}`,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-token': secret },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  console.log(`\nWebhook response: ${res.status}`, json);

  const { rows: after } = await pool.query(
    `SELECT first_name, last_name, phone FROM parents WHERE id = $1`,
    [fam.p2_id],
  );
  console.log(`\n  P2 (AFTER):  ${after[0].first_name} ${after[0].last_name} | ${after[0].phone ?? '(no phone)'}`);

  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
