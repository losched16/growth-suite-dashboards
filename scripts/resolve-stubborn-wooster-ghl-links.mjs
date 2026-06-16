// 6 Wooster parents survived the main backfill because GHL's
// /contacts/search with operator 'eq' on email returned nothing, yet
// /contacts/ POST rejects with "duplicated contact". The contact
// exists; the eq filter just doesn't find it.
//
// Try a different lookup: GET /contacts/ with a free-text `query`
// parameter, then match in-memory.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import axios from 'axios';
import crypto from 'node:crypto';

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

const APPLY = process.argv.includes('--apply');
const WOOSTER = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

function decrypt(ct, iv, tag) {
  const raw = process.env.ENCRYPTION_KEY;
  let key = Buffer.from(raw, 'base64');
  if (key.length !== 32) key = Buffer.from(raw, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

async function main() {
  const pit = await pool.query(
    `SELECT ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag FROM schools WHERE id = $1`,
    [WOOSTER],
  );
  const token = decrypt(pit.rows[0].ghl_pit_encrypted, pit.rows[0].ghl_pit_iv, pit.rows[0].ghl_pit_tag);
  const locationId = pit.rows[0].ghl_location_id;
  const ax = axios.create({
    baseURL: 'https://services.leadconnectorhq.com',
    headers: {
      Authorization: `Bearer ${token}`,
      Version: '2021-07-28',
      Accept: 'application/json',
    },
    timeout: 20_000,
  });

  // Remaining parents with email + no ghl_contact_id
  const { rows: targets } = await pool.query(
    `SELECT id, first_name, last_name, email, phone, is_primary
       FROM parents
      WHERE school_id = $1
        AND status = 'active'
        AND email IS NOT NULL AND email <> ''
        AND ghl_contact_id IS NULL
      ORDER BY last_name`,
    [WOOSTER],
  );

  console.log(`\n${targets.length} stubborn parents remaining.\n`);

  let linked = 0;
  let stillStuck = 0;

  for (const p of targets) {
    const needle = p.email.trim().toLowerCase();
    try {
      // Try the free-text `query` parameter on GET /contacts/
      const { data } = await ax.get('/contacts/', {
        params: { locationId, query: needle, limit: 25 },
      });
      const list = data.contacts ?? [];
      const found = list.find(
        (c) => (c.email ?? '').trim().toLowerCase() === needle,
      );
      if (found) {
        if (APPLY) {
          await pool.query(
            `UPDATE parents SET ghl_contact_id = $1, updated_at = now() WHERE id = $2`,
            [found.id, p.id],
          );
        }
        console.log(`  LINK     ${p.first_name} ${p.last_name} (${p.email}) → ${found.id}`);
        linked++;
      } else {
        console.log(`  STUCK    ${p.first_name} ${p.last_name} (${p.email}) — query returned ${list.length} results, none match`);
        if (list.length > 0) {
          for (const c of list.slice(0, 3)) {
            console.log(`             - ${c.id} firstName=${c.firstName} email=${c.email}`);
          }
        }
        stillStuck++;
      }
    } catch (err) {
      console.log(`  FAILED   ${p.first_name} ${p.last_name} — ${err.response?.status ?? ''} ${err.response?.data?.message ?? err.message}`);
      stillStuck++;
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`  Linked: ${linked}`);
  console.log(`  Still stuck: ${stillStuck}`);
  if (!APPLY && linked > 0) console.log(`\n  Dry run — rerun with --apply to write.`);
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
