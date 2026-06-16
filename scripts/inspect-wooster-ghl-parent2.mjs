// Fetch a few real Wooster GHL contacts and dump every custom field
// + its current value. We're hunting for parent-2 data — fields like
// `parent_2_first_name`, `mother_name`, `spouse_email`, etc.
//
// Specifically samples families that currently have ONLY 1 parent in
// our DB (i.e. the ones we'd backfill into if the data exists).

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
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

async function main() {
  // Sample 5 families with only 1 parent, picking the one parent's GHL contact id.
  const samples = await pool.query(
    `SELECT p.ghl_contact_id, p.first_name, p.last_name, f.display_name
       FROM families f
       JOIN parents p ON p.family_id = f.id
       WHERE f.school_id = $1 AND f.status = 'active' AND p.status = 'active' AND p.ghl_contact_id IS NOT NULL
       GROUP BY f.id, p.id
       HAVING (SELECT COUNT(*) FROM parents p2 WHERE p2.family_id = f.id AND p2.status='active') = 1
       ORDER BY random()
       LIMIT 5`,
    [WOOSTER],
  );

  // Load Wooster PIT — schools.ghl_pit_encrypted (+ iv + tag), AES-GCM.
  const pit = await pool.query(
    `SELECT ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag FROM schools WHERE id = $1`,
    [WOOSTER],
  );
  if (pit.rows.length === 0) throw new Error('No GHL credentials for Wooster');
  const token = decrypt(pit.rows[0].ghl_pit_encrypted, pit.rows[0].ghl_pit_iv, pit.rows[0].ghl_pit_tag);
  const locationId = pit.rows[0].ghl_location_id;

  const ax = axios.create({
    baseURL: 'https://services.leadconnectorhq.com',
    headers: {
      Authorization: `Bearer ${token}`,
      Version: '2021-07-28',
      Accept: 'application/json',
    },
  });

  // First — list all of Wooster's custom field definitions
  console.log('=== Wooster GHL custom fields (looking for parent-2-ish) ===');
  const cf = await ax.get(`/locations/${locationId}/customFields`);
  const fields = cf.data?.customFields ?? [];
  const parentLike = /parent[_-]?2|second[_-]?parent|p2_|partner|spouse|mother|father|guardian|co[_-]?parent/i;
  const matches = [];
  for (const f of fields) {
    const key = (f.fieldKey ?? f.key ?? '').replace(/^contact\./, '');
    if (parentLike.test(key) || parentLike.test(f.name ?? '')) {
      console.log(`  ${key.padEnd(40)} | ${f.name}`);
      matches.push({ id: f.id, key, name: f.name });
    }
  }
  if (matches.length === 0) console.log('  (none found in catalog)');

  console.log(`\nTotal custom fields in Wooster GHL: ${fields.length}`);
  console.log(`Of those, parent-2-ish: ${matches.length}`);

  // Now look at the actual values on 5 contacts
  for (const s of samples.rows) {
    console.log(`\n--- ${s.first_name} ${s.last_name} (${s.display_name}) — contact ${s.ghl_contact_id} ---`);
    try {
      const r = await ax.get(`/contacts/${s.ghl_contact_id}`);
      const c = r.data?.contact ?? r.data;
      // Print every custom field that has a non-empty value
      const cfArr = c.customFields ?? c.customField ?? [];
      const byId = new Map(fields.map((f) => [f.id, { key: (f.fieldKey ?? f.key ?? '').replace(/^contact\./, ''), name: f.name }]));
      const populated = [];
      for (const v of cfArr) {
        const def = byId.get(v.id);
        if (!def) continue;
        const val = v.value ?? v.field_value;
        if (val === null || val === undefined || val === '') continue;
        populated.push({ ...def, value: val });
      }
      // Show parent-2-ish ones inline, list the rest at the end
      const p2 = populated.filter((p) => parentLike.test(p.key) || parentLike.test(p.name));
      const other = populated.filter((p) => !(parentLike.test(p.key) || parentLike.test(p.name)));
      if (p2.length > 0) {
        console.log('  PARENT-2-LIKE:');
        for (const p of p2) console.log(`    ${p.key.padEnd(34)} = ${JSON.stringify(p.value).slice(0, 80)}`);
      } else {
        console.log('  (no parent-2-like custom fields populated)');
      }
      // Also print all populated field keys for visibility
      console.log(`  all populated fields (${populated.length}):`);
      for (const p of populated.slice(0, 25)) {
        console.log(`    ${p.key.padEnd(34)} = ${JSON.stringify(p.value).slice(0, 60)}`);
      }
      if (populated.length > 25) console.log(`    ... and ${populated.length - 25} more`);
    } catch (err) {
      console.log('  fetch failed:', err.response?.status, err.response?.data?.message ?? err.message);
    }
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
