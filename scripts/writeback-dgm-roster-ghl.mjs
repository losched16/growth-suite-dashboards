// Push the refreshed DGM roster fields to each student's GHL contact
// (no-overwrite: PUT replaces ONLY the listed per-slot custom fields).
//
// Writes, per student slot, the fields that change with a roster
// refresh + are mapped in the school's GHL field schema:
//   grade_level · program · homeroom · enrollment_status
//
// Slot key convention (lib/sync/desert-garden-config):
//   slot 1 -> student_<base>      slot 2-4 -> student_<slot>_<base>
//
// Scope: the 221 students whose unique_id is in the new sheet AND have
// a ghl_contact_id + ghl_slot. (New 42 have no GHL contact; 91 departed
// are left out.)
//
//   node scripts/writeback-dgm-roster-ghl.mjs            # DRY-RUN
//   node scripts/writeback-dgm-roster-ghl.mjs --apply    # write
//   node scripts/writeback-dgm-roster-ghl.mjs --apply --limit 5

import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import pg from 'pg';
import axios from 'axios';

const SCHOOL_ID = 'cfa9030d-c8fe-49ae-a9e7-f1003844ec07';
const GHL_BASE = 'https://services.leadconnectorhq.com';
const APPLY = process.argv.includes('--apply');
const limIdx = process.argv.indexOf('--limit');
const LIMIT = limIdx > -1 ? parseInt(process.argv[limIdx + 1], 10) : Infinity;

// ── env ─────────────────────────────────────────────────────────────
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('='); if (eq < 0) continue;
  const k = t.slice(0, eq).trim();
  if (!process.env[k]) process.env[k] = t.slice(eq + 1).trim().replace(/^"|"$/g, '');
}

function decryptPit(ct, iv, tag) {
  const keyBuf = Buffer.from(process.env.ENCRYPTION_KEY, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', keyBuf, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

// slot 1 -> student_<base> ; slot N -> student_<N>_<base>
const fieldKey = (slot, base) => (slot === 1 ? `student_${base}` : `student_${slot}_${base}`);

const BASE = { grade_level: 'grade_level', program: 'program', homeroom: 'homeroom', enrollment_status: 'enrollment_status' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const sheetUids = new Set(JSON.parse(readFileSync('scripts/.dgm_sheet_uids.json', 'utf8')));

const school = (await pool.query(
  `SELECT ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag FROM schools WHERE id=$1`, [SCHOOL_ID],
)).rows[0];
const pit = decryptPit(school.ghl_pit_encrypted, school.ghl_pit_iv, school.ghl_pit_tag);
const gh = axios.create({
  baseURL: GHL_BASE,
  headers: { Authorization: `Bearer ${pit}`, Version: '2021-07-28', Accept: 'application/json', 'Content-Type': 'application/json' },
  timeout: 30000,
});

// GHL custom-field catalog: fieldKey (sans contact.) -> id
const cf = (await gh.get(`/locations/${school.ghl_location_id}/customFields`)).data;
const idByKey = new Map();
for (const f of cf.customFields ?? []) {
  const k = (f.fieldKey ?? '').replace(/^contact\./, '');
  if (k) idByKey.set(k, f.id);
}
console.log(`GHL custom fields in catalog: ${idByKey.size}`);

// matched students with a GHL contact + slot
const studs = (await pool.query(
  `SELECT metadata->>'unique_id' uid,
          metadata->>'ghl_contact_id' contact_id,
          COALESCE((metadata->>'ghl_slot')::int, (metadata->>'slot')::int, 1) slot,
          metadata->>'first_name' fn, metadata->>'last_name' ln,
          metadata->>'grade_level' grade_level,
          metadata->>'program' program,
          metadata->>'homeroom' homeroom,
          metadata->>'enrollment_status' enrollment_status
     FROM students
    WHERE school_id=$1 AND metadata ? 'ghl_contact_id' AND metadata->>'ghl_contact_id' <> ''`,
  [SCHOOL_ID],
)).rows.filter((s) => sheetUids.has(s.uid));

console.log(`matched students with GHL contact: ${studs.length}`);
console.log(`mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}${LIMIT !== Infinity ? ` (limit ${LIMIT})` : ''}\n`);

let ok = 0, skipped = 0, failed = 0, n = 0;
const missingKeys = new Set();
for (const s of studs) {
  if (n >= LIMIT) break;
  n++;
  const writes = [];
  const missThis = [];
  for (const [logical, base] of Object.entries(BASE)) {
    const val = s[logical];
    if (val == null || val === '') continue;
    const key = fieldKey(s.slot, base);
    const id = idByKey.get(key);
    if (!id) { missThis.push(key); missingKeys.add(key); continue; }
    writes.push({ id, field_value: String(val) });
  }
  if (writes.length === 0) {
    skipped++;
    if (n <= 8) console.log(`  SKIP ${s.fn} ${s.ln} (slot ${s.slot}) — no matching GHL fields ${missThis.join(',')}`);
    continue;
  }
  if (!APPLY) {
    ok++;
    if (n <= 8) console.log(`  ${s.fn} ${s.ln} (slot ${s.slot}) -> ${writes.length} fields [${Object.keys(BASE).filter(k=>s[k]).join(', ')}]`);
    continue;
  }
  try {
    await gh.put(`/contacts/${s.contact_id}`, { customFields: writes });
    ok++;
    await sleep(140); // gentle rate limit
  } catch (e) {
    failed++;
    console.warn(`  FAIL ${s.fn} ${s.ln}: ${e.response?.status ?? ''} ${e.message}`);
  }
}

console.log(`\n${APPLY ? 'WROTE' : 'WOULD WRITE'}: ${ok} ok, ${skipped} skipped, ${failed} failed (of ${Math.min(studs.length, LIMIT)})`);
if (missingKeys.size) console.log('GHL field keys NOT in catalog (skipped):', [...missingKeys].join(', '));
if (!APPLY) console.log('\nDRY-RUN — nothing written. Re-run with --apply.');
await pool.end();
