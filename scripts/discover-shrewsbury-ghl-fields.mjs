// Discovery: list every custom field defined on Shrewsbury's GHL
// location so we can decide which ones to writeback into (or which
// new ones the school needs to create before we can).
//
// Reports each field's key, name, model (contact / opportunity /
// company), and data type. Read-only.

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

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

function decrypt(ciphertext, iv, tag) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ciphertext), d.final()]).toString('utf8');
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

async function main() {
  const { pit, locationId } = await loadPit();
  const res = await fetch(`${GHL_BASE}/locations/${locationId}/customFields`, {
    headers: { Authorization: `Bearer ${pit}`, Version: GHL_VERSION, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`customFields fetch failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const fields = data.customFields ?? [];
  console.log(`\nShrewsbury GHL custom fields (${fields.length}):\n`);
  console.log('  ' + 'KEY'.padEnd(40) + 'NAME'.padEnd(40) + 'MODEL'.padEnd(14) + 'TYPE');
  console.log('  ' + '-'.repeat(110));
  for (const f of fields) {
    console.log(
      '  ' +
      String(f.fieldKey ?? '').padEnd(40) +
      String(f.name ?? '').slice(0, 38).padEnd(40) +
      String(f.model ?? '').padEnd(14) +
      String(f.dataType ?? '')
    );
  }

  // Highlight likely matches for what we sync
  const needles = ['room', 'classroom', 'program', 're_enroll', 're-enroll', 'reenroll', 'homeroom'];
  console.log('\n──── Likely matches for our synced metadata ────');
  for (const needle of needles) {
    const hits = fields.filter((f) =>
      (f.fieldKey ?? '').toLowerCase().includes(needle) ||
      (f.name ?? '').toLowerCase().includes(needle)
    );
    if (hits.length === 0) continue;
    console.log(`  "${needle}":`);
    for (const f of hits) {
      console.log(`     - key=${f.fieldKey}  name="${f.name}"  type=${f.dataType}  model=${f.model}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => pool.end());
