// Shrewsbury Montessori — DB → GHL writeback for the tag-synced fields.
//
// Companion to scripts/sync-shrewsbury-tags-from-ghl.mjs. The sync pulls
// `re-enrolled` / `room X` / age-band tags out of GHL into our DB. This
// writeback pushes the normalized values back to GHL as proper custom
// fields so GHL workflows can branch on "Re-enrolled = Yes" without
// having to substring-match a tag list.
//
// Custom fields (auto-created on first run if missing):
//   re_enrolled     TEXT  — "Yes" when the "re-enrolled" tag is set; "" otherwise
//   current_room    TEXT  — "Room 7" / "Room B" / null
//   current_program TEXT  — "Toddler (Full Day)" / "Kindergarten" / null
//
// (CHECKBOX would be the natural type for re_enrolled but the GHL
// API requires preset options for it; TEXT keeps the schema dead-
// simple. Workflows can filter on "= Yes" the same way.)
//
// Conflict policy: TAGS WIN. We overwrite whatever's in the GHL custom
// field today because tags are upstream — if a school changes a tag,
// the field should follow. (Wooster's writeback uses "never overwrite
// populated" because Wooster imports from Final Forms which can drift;
// Shrewsbury's data origin is GHL itself.)
//
// Idempotent. Re-run after every sync.
//   node scripts/sync-shrewsbury-tags-from-ghl.mjs
//   node scripts/writeback-shrewsbury-ghl.mjs
//
// Flags:
//   --dry-run            no GHL writes; just report what would change
//   --limit=N            only process the first N parents (for testing)
//   --skip-field-create  refuse to create missing fields; abort instead

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
const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_CREATE = process.argv.includes('--skip-field-create');
const LIMIT = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1]) || 0;

if (DRY_RUN) console.log('[DRY RUN] no GHL writes will be made');
if (LIMIT)   console.log(`[LIMIT] processing first ${LIMIT} parents only`);

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';

// The 3 fields we own. fieldKey + dataType + position determine creation.
const FIELDS_WE_OWN = [
  { fieldKey: 're_enrolled',     name: 'Re-enrolled',     dataType: 'TEXT', position: 0 },
  { fieldKey: 'current_room',    name: 'Current Room',    dataType: 'TEXT', position: 1 },
  { fieldKey: 'current_program', name: 'Current Program', dataType: 'TEXT', position: 2 },
];

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

function decrypt(ciphertext, iv, tag) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ciphertext), d.final()]).toString('utf8');
}

async function ghlReq(method, pit, path, body) {
  const r = await fetch(`${GHL_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${pit}`,
      Version: GHL_VERSION,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`${method} ${path} → ${r.status}: ${text}`);
  }
  return r.json();
}

// Resolve each of our owned fields to a GHL id, creating any that are
// missing (unless --skip-field-create was passed).
async function ensureFields(pit, locationId) {
  const data = await ghlReq('GET', pit, `/locations/${locationId}/customFields`);
  const existing = new Map();
  for (const f of data.customFields ?? []) {
    // The GHL API returns fieldKey prefixed with the model — strip
    // "contact." so we can match against our plain keys.
    existing.set((f.fieldKey || '').replace(/^contact\./, ''), f);
  }

  const idByKey = new Map();
  const created = [];
  const reused = [];
  for (const f of FIELDS_WE_OWN) {
    const hit = existing.get(f.fieldKey);
    if (hit) {
      idByKey.set(f.fieldKey, hit.id);
      reused.push(f.fieldKey);
      continue;
    }
    if (SKIP_CREATE) {
      throw new Error(`Custom field "${f.fieldKey}" missing in GHL and --skip-field-create was passed. Aborting.`);
    }
    if (DRY_RUN) {
      console.log(`  [dry-run] WOULD CREATE custom field key=${f.fieldKey} name="${f.name}" type=${f.dataType}`);
      idByKey.set(f.fieldKey, `would-create:${f.fieldKey}`);
      continue;
    }
    const res = await ghlReq('POST', pit, `/locations/${locationId}/customFields`, {
      name: f.name,
      dataType: f.dataType,
      position: f.position,
      model: 'contact',
    });
    const newId = res.customField?.id ?? res.id;
    if (!newId) throw new Error(`createCustomField returned no id for ${f.fieldKey}: ${JSON.stringify(res)}`);
    idByKey.set(f.fieldKey, newId);
    created.push(f.fieldKey);
  }
  return { idByKey, created, reused };
}

async function main() {
  const c = await pool.connect();
  try {
    const { rows: schools } = await c.query(
      `SELECT id, ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag
         FROM schools WHERE id = $1`,
      [SHREWSBURY_SCHOOL_ID],
    );
    const sch = schools[0];
    if (!sch) throw new Error('Shrewsbury school not found');
    const pit = decrypt(sch.ghl_pit_encrypted, sch.ghl_pit_iv, sch.ghl_pit_tag);
    const locationId = sch.ghl_location_id;

    console.log(`[shrewsbury-writeback] location ${locationId}`);
    console.log(`[shrewsbury-writeback] ensuring 3 custom fields exist…`);
    const { idByKey, created, reused } = await ensureFields(pit, locationId);
    if (created.length) console.log(`  ✓ created: ${created.join(', ')}`);
    if (reused.length)  console.log(`  ✓ reused existing: ${reused.join(', ')}`);

    // Pull every parent contact with a linked Shrewsbury student that
    // has any of the tag-derived fields set. We dedupe by ghl_contact_id
    // because slot 1 / slot 2 students share a contact — first hit wins
    // since tags are contact-level anyway.
    let q = `
      SELECT DISTINCT ON (s.metadata->>'ghl_contact_id')
             s.metadata->>'ghl_contact_id' AS ghl_contact_id,
             s.first_name, s.last_name,
             (s.metadata->>'re_enrolled')::boolean AS re_enrolled,
             s.metadata->>'homeroom' AS current_room,
             s.metadata->>'program'  AS current_program
        FROM students s
       WHERE s.school_id = $1
         AND s.metadata->>'ghl_contact_id' IS NOT NULL
         AND (
           s.metadata->>'re_enrolled' = 'true'
           OR s.metadata->>'homeroom'  IS NOT NULL
           OR s.metadata->>'program'   IS NOT NULL
         )
       ORDER BY s.metadata->>'ghl_contact_id', (s.metadata->>'ghl_slot')::int NULLS LAST
    `;
    if (LIMIT > 0) q += ` LIMIT ${LIMIT}`;
    const { rows: targets } = await c.query(q, [SHREWSBURY_SCHOOL_ID]);
    console.log(`\n[shrewsbury-writeback] ${targets.length} contacts to update\n`);

    const counts = { contacts: 0, writes: 0, failures: 0 };
    for (const t of targets) {
      counts.contacts++;
      // Build the customFields PUT payload. We always include all 3
      // fields so the "tags win" policy is enforced — passing null /
      // false for a kid whose tag was removed clears the GHL field too.
      const customFields = [
        { id: idByKey.get('re_enrolled'),     field_value: t.re_enrolled === true ? 'Yes' : '' },
        { id: idByKey.get('current_room'),    field_value: t.current_room ?? '' },
        { id: idByKey.get('current_program'), field_value: t.current_program ?? '' },
      ];

      if (DRY_RUN) {
        console.log(`  [dry-run] WOULD PUT contact=${t.ghl_contact_id}  re=${t.re_enrolled}  room="${t.current_room ?? ''}"  prog="${t.current_program ?? ''}"`);
        counts.writes++;
        continue;
      }
      try {
        await ghlReq('PUT', pit, `/contacts/${t.ghl_contact_id}`, { customFields });
        counts.writes++;
        if (counts.writes % 50 === 0) {
          console.log(`  …${counts.writes} contacts written`);
        }
      } catch (e) {
        counts.failures++;
        console.error(`  ✗ ${t.ghl_contact_id}: ${e.message}`);
      }
    }

    console.log('\n──── Summary ────');
    console.log(`  Contacts processed: ${counts.contacts}`);
    console.log(`  Writes attempted:   ${counts.writes}`);
    console.log(`  Failures:           ${counts.failures}`);
    if (DRY_RUN) console.log('  (dry run — no changes persisted)');
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
