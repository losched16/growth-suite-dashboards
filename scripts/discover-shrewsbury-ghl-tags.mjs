// Discovery: pull every tag currently in use across Shrewsbury Montessori's
// GHL location and report a frequency table. Read-only — no DB writes.
//
// Output:
//   tag-name                              N contacts
//   --------------------------------------------------
//   re-enroll                                   142
//   classroom 1                                  18
//   classroom 2                                  20
//   ...
//
// Use this to confirm exact tag spellings before writing the sync that
// folds them into students.metadata.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
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

const SHREWSBURY_SCHOOL_ID = 'bf5e15d7-c0df-4ac6-9b6f-ededee90b02a';
const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function decrypt(ciphertext, iv, tag) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

async function loadPit() {
  const r = await pool.query(
    `SELECT ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag
     FROM schools WHERE id = $1`,
    [SHREWSBURY_SCHOOL_ID],
  );
  if (r.rowCount === 0) throw new Error('Shrewsbury school row not found');
  const row = r.rows[0];
  return {
    locationId: row.ghl_location_id,
    pit: decrypt(row.ghl_pit_encrypted, row.ghl_pit_iv, row.ghl_pit_tag),
  };
}

// Pulls ALL contacts for the location (no filter) and aggregates tag
// frequencies. Stops at 50 pages = 5000 contacts max, which is fine for
// a school the size of Shrewsbury.
async function fetchAllContacts(pit, locationId) {
  const all = [];
  let page = 1;
  const pageLimit = 100;
  while (page <= 50) {
    const res = await fetch(`${GHL_BASE}/contacts/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pit}`,
        Version: GHL_VERSION,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ locationId, pageLimit, page }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`contacts/search page ${page} failed: ${res.status} ${t}`);
    }
    const data = await res.json();
    const contacts = data.contacts ?? [];
    all.push(...contacts);
    if (contacts.length < pageLimit) break;
    page++;
  }
  return all;
}

async function main() {
  const { pit, locationId } = await loadPit();
  console.log(`[shrewsbury-discover] location ${locationId}`);
  console.log(`[shrewsbury-discover] fetching contacts…`);
  const contacts = await fetchAllContacts(pit, locationId);
  console.log(`[shrewsbury-discover] fetched ${contacts.length} contacts\n`);

  const counts = new Map();
  let withAnyTag = 0;
  for (const c of contacts) {
    const tags = Array.isArray(c.tags) ? c.tags : [];
    if (tags.length > 0) withAnyTag++;
    for (const t of tags) {
      const k = String(t).toLowerCase().trim();
      if (!k) continue;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`Tag frequency (${counts.size} distinct tags, ${withAnyTag} of ${contacts.length} contacts have tags):\n`);
  console.log('  ' + 'TAG'.padEnd(50) + 'CONTACTS');
  console.log('  ' + '-'.repeat(58));
  for (const [tag, n] of sorted) {
    console.log('  ' + tag.padEnd(50) + String(n).padStart(5));
  }

  // Highlight likely matches for what the user mentioned
  console.log('\n──── Likely matches ────');
  const reTags = sorted.filter(([t]) => /re-?enroll/.test(t));
  const classroomTags = sorted.filter(([t]) => /class[\s_-]*(room|\d)/.test(t));
  console.log(`re-enroll candidates (${reTags.length}):`);
  for (const [t, n] of reTags) console.log(`    ${t}  (${n})`);
  console.log(`classroom candidates (${classroomTags.length}):`);
  for (const [t, n] of classroomTags) console.log(`    ${t}  (${n})`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => pool.end());
