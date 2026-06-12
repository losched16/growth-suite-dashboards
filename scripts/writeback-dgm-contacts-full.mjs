// Full GHL contact writeback for DGM: put the 6-11 family-roster data
// on EVERY linked parent contact (not just the historical one-per-
// family primary contact):
//
//   standard fields : address1 / city / state / postalCode (from sheet)
//   custom fields   : household_id + per-student slot fields for the
//                     family's active students —
//                     first_name, last_name, id (unique_id),
//                     grade_level, program, homeroom,
//                     enrollment_status, birth_date
//
// Slot rule (desert-garden-config): slot 1 bare 'student_<k>',
// slots 2-4 'student_<n>_<k>'. PUT replaces only the listed keys.
// Phones intentionally NOT re-sent (GHL dupe guard already vetted).
//
//   node scripts/writeback-dgm-contacts-full.mjs            # dry-run
//   node scripts/writeback-dgm-contacts-full.mjs --apply
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import pg from 'pg';
import axios from 'axios';

const XLSX_PATH = String.raw`C:\Users\thelo\Downloads\Family Roster as of 6 11.xlsx`;
const SCHOOL_ID = 'cfa9030d-c8fe-49ae-a9e7-f1003844ec07';
const DEMO_FAMILY_ID = 'cdf70975-b0a4-4f3a-8a34-2858bfffe750';
const APPLY = process.argv.includes('--apply');

for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('='); if (eq < 0) continue;
  const k = t.slice(0, eq).trim();
  if (!process.env[k]) process.env[k] = t.slice(eq + 1).trim().replace(/^"|"$/g, '');
}
function decryptPit(ct, iv, tag) {
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(process.env.ENCRYPTION_KEY, 'base64'), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slotKey = (slot, base) => (slot === 1 ? `student_${base}` : `student_${slot}_${base}`);

// ── sheet: per-email address ────────────────────────────────────────
// (xlsx parsing via python is overkill here; reuse a tiny csv dump
// approach — read with exceljs? Not installed. Use python inline.)
import { execFileSync } from 'node:child_process';
const py = `
import openpyxl, json, sys
wb = openpyxl.load_workbook(r'''${XLSX_PATH}''', read_only=True, data_only=True)
rows = list(wb['Sheet1'].iter_rows(values_only=True))
out = {}
for r in rows[1:]:
    if not r or not r[1]: continue
    em = (str(r[7]).strip().lower() if r[7] else '')
    if not em or '@' not in em: continue
    if em not in out:
        out[em] = { 'street': str(r[8]).strip() if r[8] else '', 'city': str(r[9]).strip() if r[9] else '',
                    'state': str(r[10]).strip() if r[10] else '', 'zip': str(r[12]).strip() if r[12] else '' }
print(json.dumps(out))
`;
const addrByEmail = JSON.parse(execFileSync('python', ['-c', py], { encoding: 'utf8' }));
console.log(`sheet addresses: ${Object.keys(addrByEmail).length} distinct parent emails`);

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const school = (await pool.query(`SELECT ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag FROM schools WHERE id=$1`, [SCHOOL_ID])).rows[0];
const gh = axios.create({
  baseURL: 'https://services.leadconnectorhq.com',
  headers: { Authorization: `Bearer ${decryptPit(school.ghl_pit_encrypted, school.ghl_pit_iv, school.ghl_pit_tag)}`, Version: '2021-07-28', 'Content-Type': 'application/json' },
  timeout: 30000,
});

// GHL custom-field key -> id
const cf = (await gh.get(`/locations/${school.ghl_location_id}/customFields`)).data;
const idByKey = new Map();
for (const f of cf.customFields ?? []) {
  const k = (f.fieldKey ?? '').replace(/^contact\./, '');
  if (k) idByKey.set(k, f.id);
}

// families -> active students (slot-ordered) + parents (linked)
const fams = (await pool.query(`
  SELECT f.id family_id
    FROM families f WHERE f.school_id=$1 AND f.status='active' AND f.id <> $2`,
  [SCHOOL_ID, DEMO_FAMILY_ID])).rows;
const studs = (await pool.query(`
  SELECT family_id, first_name, last_name, date_of_birth,
         metadata->>'unique_id' uid, metadata->>'ghl_slot' slot,
         metadata->>'grade_level' grade, metadata->>'program' program,
         metadata->>'homeroom' homeroom, metadata->>'enrollment_status' enr,
         metadata->>'household_id' hh
    FROM students WHERE school_id=$1 AND status='active'`, [SCHOOL_ID])).rows;
const parents = (await pool.query(`
  SELECT p.family_id, p.id, p.first_name, p.last_name, lower(p.email) email, p.ghl_contact_id
    FROM parents p JOIN families f ON f.id=p.family_id
   WHERE p.school_id=$1 AND p.status='active' AND f.status='active'
     AND p.ghl_contact_id IS NOT NULL AND p.family_id <> $2`, [SCHOOL_ID, DEMO_FAMILY_ID])).rows;

const studsByFamily = new Map();
for (const s of studs) {
  const list = studsByFamily.get(s.family_id) ?? [];
  list.push(s);
  studsByFamily.set(s.family_id, list);
}
for (const list of studsByFamily.values()) {
  list.sort((a, b) => (parseInt(a.slot ?? '99', 10) - parseInt(b.slot ?? '99', 10)) || a.first_name.localeCompare(b.first_name));
}

console.log(`linked active parents: ${parents.length} · families with students: ${studsByFamily.size}`);
console.log(`mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}\n`);

let ok = 0, failed = 0, fieldsTotal = 0;
const missingKeys = new Set();
for (const p of parents) {
  const kids = (studsByFamily.get(p.family_id) ?? []).slice(0, 4);
  const customFields = [];
  const push = (key, val) => {
    if (val == null || String(val).trim() === '') return;
    const id = idByKey.get(key);
    if (!id) { missingKeys.add(key); return; }
    customFields.push({ id, field_value: String(val) });
  };
  // household id from any kid
  const hh = kids.find((k) => k.hh)?.hh;
  push('household_id', hh);
  kids.forEach((k, i) => {
    const slot = i + 1;
    push(slotKey(slot, 'first_name'), k.first_name);
    push(slotKey(slot, 'last_name'), k.last_name);
    push(slotKey(slot, 'id'), k.uid);
    push(slotKey(slot, 'grade_level'), k.grade);
    push(slotKey(slot, 'program'), k.program);
    push(slotKey(slot, 'homeroom'), k.homeroom);
    push(slotKey(slot, 'enrollment_status'), k.enr);
    if (k.date_of_birth) {
      // pg returns a Date object — String(Date) is 'Wed May 15 2024…',
      // which GHL mis-parses. Always emit ISO yyyy-mm-dd.
      const dob = k.date_of_birth instanceof Date
        ? k.date_of_birth.toISOString().slice(0, 10)
        : String(k.date_of_birth).slice(0, 10);
      push(slotKey(slot, 'birth_date'), dob);
    }
  });

  const body = {};
  const addr = addrByEmail[p.email];
  if (addr?.street) { body.address1 = addr.street; body.city = addr.city; body.state = addr.state; body.postalCode = addr.zip; }
  if (customFields.length) body.customFields = customFields;
  if (Object.keys(body).length === 0) continue;

  if (!APPLY) { ok++; fieldsTotal += customFields.length; continue; }
  try {
    await gh.put(`/contacts/${p.ghl_contact_id}`, body);
    ok++; fieldsTotal += customFields.length;
    await sleep(160);
  } catch (e) {
    failed++;
    if (failed <= 6) console.warn(`  FAIL ${p.first_name} ${p.last_name}: ${e.response?.status ?? ''} ${JSON.stringify(e.response?.data ?? {}).slice(0, 120)}`);
  }
}
console.log(`${APPLY ? 'updated' : 'would update'} ${ok} contacts (${fieldsTotal} custom-field writes), failed ${failed}`);
if (missingKeys.size) console.log('keys not in GHL catalog (skipped):', [...missingKeys].slice(0, 12).join(', '), missingKeys.size > 12 ? `… +${missingKeys.size - 12}` : '');
if (!APPLY) console.log('\nDRY-RUN — re-run with --apply.');
await pool.end();
