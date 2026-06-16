// Hot-fix: pull every Wooster contact's tags from GHL and populate
// the local ghl_contact_tags table. The full attribute sync should
// be doing this on the 15-min cron, but for Wooster the table was
// empty — so the tracker filter has nothing to read against.
//
// This script is the minimum subset: list all contacts, walk their
// tags arrays, replace the table.
//
// Usage:
//   node scripts/sync-wooster-tags.mjs

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

const WOOSTER = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

function decrypt(ct, iv, tag) {
  const raw = process.env.ENCRYPTION_KEY;
  let key = Buffer.from(raw, 'base64');
  if (key.length !== 32) key = Buffer.from(raw, 'hex');
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

async function main() {
  const r = await pool.query(
    `SELECT ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag FROM schools WHERE id = $1`,
    [WOOSTER],
  );
  const token = decrypt(r.rows[0].ghl_pit_encrypted, r.rows[0].ghl_pit_iv, r.rows[0].ghl_pit_tag);
  const locationId = r.rows[0].ghl_location_id;
  const ax = axios.create({
    baseURL: 'https://services.leadconnectorhq.com',
    headers: { Authorization: `Bearer ${token}`, Version: '2021-07-28', Accept: 'application/json' },
    timeout: 30_000,
  });

  // Walk all contacts via /contacts/search
  console.log('Fetching all Wooster contacts...');
  const all = [];
  let page = 1;
  for (;;) {
    const { data } = await ax.post('/contacts/search', { locationId, pageLimit: 100, page });
    const list = data.contacts ?? [];
    all.push(...list);
    process.stdout.write(`  page ${page} → ${list.length} contacts, total ${all.length}\n`);
    if (list.length < 100) break;
    page++;
    if (page > 100) { console.warn('  bailing at 100 pages'); break; }
  }

  // Build (contactId, tag) rows
  const rows = [];
  const tagCounts = new Map();
  for (const c of all) {
    for (const t of c.tags ?? []) {
      const tag = String(t).trim();
      if (!tag) continue;
      rows.push([c.id, tag]);
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }
  console.log(`\nFound ${rows.length} tag-rows across ${all.length} contacts.`);
  console.log('Top tags:');
  const sorted = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  for (const [tag, n] of sorted) console.log(`  ${n.toString().padStart(4)}  ${tag}`);

  console.log('\nReplacing ghl_contact_tags for Wooster...');
  await pool.query(`DELETE FROM ghl_contact_tags WHERE school_id = $1`, [WOOSTER]);
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const placeholders = chunk.map((_, j) => `($1, $${j * 2 + 2}, $${j * 2 + 3})`).join(',');
    await pool.query(
      `INSERT INTO ghl_contact_tags (school_id, ghl_contact_id, tag) VALUES ${placeholders} ON CONFLICT DO NOTHING`,
      [WOOSTER, ...chunk.flat()],
    );
  }
  console.log('Done.');
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
