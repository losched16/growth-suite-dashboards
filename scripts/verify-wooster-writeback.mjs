// Verify the new portal-form writeback chain reaches Wooster's GHL contact
// with the correct field keys (matching the Wooster Doc Tracker conventions).
//
// What we do:
//   1. Pick a known Wooster parent + one of their students.
//   2. Snapshot the relevant `form_*_complete` GHL custom field BEFORE.
//   3. Replicate the production writeback logic for one form (one per-student
//      slug, one family-level slug). We write a known sentinel date.
//   4. Snapshot AFTER and diff.
//   5. Print clearly what landed and which keys were used.
//
// No portal_form_submissions row is created — this is a pure GHL write test
// (the production submit route already covers the submission storage path
// via its existing tests; here we're verifying the GHL key mapping).
//
// Usage: node scripts/verify-wooster-writeback.mjs

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

const WOOSTER = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
const TEST_PARENT_EMAIL = 'tabetha3185@gmail.com';
const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

function decrypt(ct, iv, tag) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

async function fetchFieldSchema(pit, locationId) {
  const r = await fetch(`${GHL_BASE}/locations/${locationId}/customFields`, {
    headers: { Authorization: `Bearer ${pit}`, Version: GHL_VERSION, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error('field schema fetch failed');
  const data = await r.json();
  const byKey = new Map();
  const byId = new Map();
  for (const f of data.customFields || []) {
    const raw = f.fieldKey || f.key;
    if (!raw || !f.id) continue;
    const normalized = raw.startsWith('contact.') ? raw.slice('contact.'.length) : raw;
    byKey.set(normalized, { id: f.id, name: f.name, dataType: f.dataType });
    byId.set(f.id, { name: f.name, fieldKey: normalized, dataType: f.dataType });
  }
  return { byKey, byId };
}

async function fetchContact(pit, contactId) {
  const r = await fetch(`${GHL_BASE}/contacts/${contactId}`, {
    headers: { Authorization: `Bearer ${pit}`, Version: GHL_VERSION, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`contact fetch failed: ${r.status}`);
  return (await r.json()).contact || {};
}

async function writeCustomFields(pit, contactId, byKey, updates) {
  // updates: { ghlKey: value }
  const customFields = [];
  const skipped = [];
  for (const [k, v] of Object.entries(updates)) {
    const info = byKey.get(k);
    if (!info) { skipped.push(k); continue; }
    customFields.push({ id: info.id, field_value: v });
  }
  if (!customFields.length) return { updated: 0, skipped };
  const r = await fetch(`${GHL_BASE}/contacts/${contactId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${pit}`,
      Version: GHL_VERSION,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ customFields }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`PUT contact failed: ${r.status} ${t}`);
  }
  return { updated: customFields.length, skipped };
}

(async () => {
  const sr = await pool.query('SELECT ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag FROM schools WHERE id = $1', [WOOSTER]);
  const pit = decrypt(sr.rows[0].ghl_pit_encrypted, sr.rows[0].ghl_pit_iv, sr.rows[0].ghl_pit_tag);
  const locationId = sr.rows[0].ghl_location_id;

  const pr = await pool.query(`
    SELECT p.id AS parent_id, p.family_id, p.ghl_contact_id, p.first_name, p.last_name
      FROM parents p
     WHERE p.school_id = $1 AND LOWER(p.email) = LOWER($2) AND p.is_primary = true
  `, [WOOSTER, TEST_PARENT_EMAIL]);
  const parent = pr.rows[0];
  console.log(`Parent:  ${parent.first_name} ${parent.last_name}`);
  console.log(`Contact: ${parent.ghl_contact_id}`);

  const sR = await pool.query(`
    SELECT id, first_name, last_name, metadata
      FROM students WHERE family_id = $1 AND status = 'active'
      ORDER BY (metadata->>'slot')::int NULLS LAST
  `, [parent.family_id]);
  for (const s of sR.rows) {
    console.log(`  student slot=${(s.metadata||{}).slot}  ${s.first_name} ${s.last_name}`);
  }

  // Fetch the field schema for this location and the contact's current values
  const { byKey, byId } = await fetchFieldSchema(pit, locationId);
  console.log(`\nGHL field schema: ${byKey.size} fields`);

  // ---- BEFORE snapshot ----
  const contactBefore = await fetchContact(pit, parent.ghl_contact_id);
  function valueFor(key) {
    const info = byKey.get(key);
    if (!info) return '(field missing in schema)';
    const cf = (contactBefore.customFields || []).find((x) => x.id === info.id);
    return cf?.value == null ? '(empty)' : String(cf.value);
  }

  // Test keys we care about for the Doc Tracker
  const TEST_KEYS = [
    'form_emergency_medical_complete',   // family-level
    'form_media_permission_complete',    // family-level
    'form_ode_connectivity_complete',    // family-level
    'form_enrollment_agreement_s1',
    'form_enrollment_agreement_s2',
    'form_enrollment_agreement_s3',
    'form_health_history_s1',
    'form_health_history_s2',
    'form_medications_s1',
    'form_injury_history_s1',
  ];
  console.log(`\n--- BEFORE writeback ---`);
  for (const k of TEST_KEYS) console.log(`  ${k.padEnd(40)}  ${valueFor(k)}`);

  // ---- Simulate writeback ----
  // We write a sentinel date that's obviously a test: a tag the operator
  // can identify. We pick one family-level + one slot-1 + one slot-2 field.
  const sentinelDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const slot1Student = sR.rows.find((s) => (s.metadata || {}).slot == 1);
  const slot2Student = sR.rows.find((s) => (s.metadata || {}).slot == 2);

  const writes = {
    'form_media_permission_complete': sentinelDate,
  };
  if (slot1Student) writes['form_enrollment_agreement_s1'] = sentinelDate;
  if (slot2Student) writes['form_enrollment_agreement_s2'] = sentinelDate;

  console.log(`\nWriting:`);
  for (const [k, v] of Object.entries(writes)) console.log(`  ${k} = ${v}`);

  const wr = await writeCustomFields(pit, parent.ghl_contact_id, byKey, writes);
  console.log(`\nGHL response: updated ${wr.updated}, skipped ${wr.skipped.length}`);
  if (wr.skipped.length) console.log(`  skipped keys: ${wr.skipped.join(', ')}`);

  // ---- AFTER snapshot ----
  await new Promise((r) => setTimeout(r, 1500));
  const contactAfter = await fetchContact(pit, parent.ghl_contact_id);
  function valueAfter(key) {
    const info = byKey.get(key);
    if (!info) return '(field missing)';
    const cf = (contactAfter.customFields || []).find((x) => x.id === info.id);
    return cf?.value == null ? '(empty)' : String(cf.value);
  }
  console.log(`\n--- AFTER writeback ---`);
  for (const k of TEST_KEYS) {
    const before = valueFor(k);
    const after = valueAfter(k);
    const changed = before !== after;
    console.log(`  ${changed ? '✓' : ' '} ${k.padEnd(40)}  ${after}`);
  }

  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
