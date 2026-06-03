// One-off: pull `contact.gender` from Shrewsbury's GHL contacts and
// write it onto the linked slot-1 student in our DB. The roster widget
// already has a `gender` column + gender filter — they just had no
// data to render.
//
// Conservative scope: only updates the lowest-slot student per contact
// (Shrewsbury contacts can hold multiple students; per-student gender
// doesn't exist as a GHL field yet, so we don't guess).
//
// Idempotent. Re-runnable.

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

async function main() {
  const sch = (await pool.query(
    `SELECT ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag
       FROM schools WHERE id = $1`,
    [SHREWSBURY_SCHOOL_ID],
  )).rows[0];
  const pit = decrypt(sch.ghl_pit_encrypted, sch.ghl_pit_iv, sch.ghl_pit_tag);
  const locationId = sch.ghl_location_id;

  // Find the field id for contact.gender (the STUDENT gender field on
  // Shrewsbury; parent gender lives on a separate custom field).
  const cfRes = await fetch(`${GHL_BASE}/locations/${locationId}/customFields`, {
    headers: { Authorization: `Bearer ${pit}`, Version: GHL_VERSION },
  });
  const cfData = await cfRes.json();
  const genderField = (cfData.customFields ?? []).find((f) => f.fieldKey === 'contact.gender');
  if (!genderField) throw new Error('contact.gender custom field not found');
  console.log(`[shrewsbury-gender] gender field id = ${genderField.id}`);

  // Pull all contacts (paged)
  console.log('[shrewsbury-gender] fetching contacts…');
  const genderByContact = new Map();
  let page = 1;
  const pageLimit = 100;
  while (page <= 50) {
    const r = await fetch(`${GHL_BASE}/contacts/search`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pit}`, Version: GHL_VERSION, 'Content-Type': 'application/json' },
      body: JSON.stringify({ locationId, pageLimit, page }),
    });
    const data = await r.json();
    const contacts = data.contacts ?? [];
    for (const ct of contacts) {
      for (const cf of (ct.customFields ?? [])) {
        if (cf.id === genderField.id && cf.value) {
          genderByContact.set(ct.id, String(cf.value).trim());
        }
      }
    }
    if (contacts.length < pageLimit) break;
    page++;
  }
  console.log(`[shrewsbury-gender] ${genderByContact.size} contacts have a gender value`);

  // Apply to the LOWEST-slot student per contact (Shrewsbury data
  // doesn't carry per-slot student gender — we don't guess for slot 2+).
  let updated = 0, alreadyMatched = 0;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const [contactId, gender] of genderByContact) {
      const { rows } = await c.query(
        `SELECT id, gender FROM students
          WHERE school_id = $1
            AND metadata->>'ghl_contact_id' = $2
          ORDER BY COALESCE((metadata->>'ghl_slot')::int, 1) ASC
          LIMIT 1`,
        [SHREWSBURY_SCHOOL_ID, contactId],
      );
      if (rows.length === 0) continue;
      const s = rows[0];
      if ((s.gender ?? '').toLowerCase() === gender.toLowerCase()) {
        alreadyMatched++;
        continue;
      }
      await c.query(
        `UPDATE students SET gender = $1, updated_at = now() WHERE id = $2`,
        [gender, s.id],
      );
      updated++;
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK'); throw e;
  } finally {
    c.release();
  }

  console.log(`\n──── Summary ────`);
  console.log(`  Updated:         ${updated}`);
  console.log(`  Already matched: ${alreadyMatched}`);

  const post = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE gender ILIKE 'female') AS female,
       COUNT(*) FILTER (WHERE gender ILIKE 'male')   AS male,
       COUNT(*) FILTER (WHERE gender IS NULL)        AS unknown
       FROM students WHERE school_id = $1`,
    [SHREWSBURY_SCHOOL_ID],
  );
  console.log(`  Post-sync: ${post.rows[0].female} F · ${post.rows[0].male} M · ${post.rows[0].unknown} unknown`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => pool.end());
