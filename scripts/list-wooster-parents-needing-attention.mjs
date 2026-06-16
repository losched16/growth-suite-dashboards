// Listing of Wooster parents who can't currently receive a magic-link
// email — either no email on file, or email exists but our GHL contact
// search couldn't find a matching contact (and "create" rejected as
// duplicate). The office can use this to remediate before the parent
// blast goes out.
//
// Output: CSV-style table to stdout. Safe to run any time.

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

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

async function main() {
  const { rows: stuck } = await pool.query(
    `SELECT p.first_name, p.last_name, p.email, p.is_primary,
            f.display_name AS family
       FROM parents p
       JOIN families f ON f.id = p.family_id
      WHERE p.school_id = $1 AND p.status = 'active'
        AND p.email IS NOT NULL AND p.email <> ''
        AND p.ghl_contact_id IS NULL
      ORDER BY p.last_name, p.first_name`,
    [WOOSTER],
  );

  const { rows: noEmail } = await pool.query(
    `SELECT p.first_name, p.last_name, p.is_primary,
            f.display_name AS family
       FROM parents p
       JOIN families f ON f.id = p.family_id
      WHERE p.school_id = $1 AND p.status = 'active'
        AND (p.email IS NULL OR p.email = '')
      ORDER BY f.display_name, p.is_primary DESC, p.first_name`,
    [WOOSTER],
  );

  console.log(`=== Group A: email on file, GHL contact missing (${stuck.length}) ===`);
  console.log(`Action needed: in GHL, look up by email, copy the contactId, link manually.\n`);
  for (const r of stuck) {
    console.log(`  ${r.is_primary ? 'PRIMARY' : 'P2     '} | ${r.first_name} ${r.last_name} | ${r.email} | family: ${r.family}`);
  }

  console.log(`\n=== Group B: no email on file (${noEmail.length}) ===`);
  console.log(`Action needed: contact the family, get an email, update via GHL or office portal.\n`);
  let lastFam = '';
  for (const r of noEmail) {
    const fam = r.family !== lastFam ? r.family : '';
    if (fam) console.log(`  --- ${fam} ---`);
    console.log(`    ${r.is_primary ? 'PRIMARY' : 'P2     '} | ${r.first_name} ${r.last_name}`);
    lastFam = r.family;
  }

  console.log(`\n=== Summary ===`);
  console.log(`  ${stuck.length} parents stuck on GHL link (needs manual contact ID copy)`);
  console.log(`  ${noEmail.length} parents have no email (needs office outreach to family)`);
  console.log(`  Total unreachable today: ${stuck.length + noEmail.length}`);

  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
