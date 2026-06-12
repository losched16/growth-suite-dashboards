// Extended GHL contact writeback for DGM after the 0612 fresh import
// (Sonia Reviewed DB + Parent Dump + FACTS): push the FULL per-student
// field set from students.metadata onto every linked parent contact,
// so GHL matches the new source of truth before the bidirectional
// attribute sync is re-enabled.
//
//   standard fields : address1 / city / state / postalCode
//                     (per-parent, from Parent Dump 6 11.xlsx)
//   custom fields   : household_id + per-student slot fields:
//                     identity (first/last/id/birth_date/gender/
//                     grade_level/program/homeroom/enrollment_status)
//                     + program_name, lead_teacher, daily_schedule,
//                     initial_start_date, current_year_enrollment_
//                     start_date, age, tuition_fee, program_tuition,
//                     field_needed_for_tuition, extended_day,
//                     organic_lunch, payment_plan, months_enrolled,
//                     graduation_year, financial_aid, allergy, iep,
//                     504_plan, legal_authority, physical_custody
//
// Slot list includes WITHDRAWN students (their enrollment_status must
// read "Withdrawn" in GHL rather than lingering as Enrolled). Assigned
// slots are persisted to students.metadata.ghl_slot so the GHL→
// dashboard propagation maps fields to the right student.
//
//   node scripts/writeback-dgm-contacts-0612.mjs            # dry-run
//   node scripts/writeback-dgm-contacts-0612.mjs --apply
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import pg from 'pg';
import axios from 'axios';

const DUMP_PATH = String.raw`C:\Users\thelo\Downloads\Parent Dump 6 11.xlsx`;
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
const dateOnly = (v) => {
  if (!v) return null;
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
};

// Parent addresses from the dump (per parent email).
const py = `
import openpyxl, json
wb = openpyxl.load_workbook(r'''${DUMP_PATH}''', read_only=True, data_only=True)
rows = list(wb.active.iter_rows(values_only=True))
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
console.log(`dump addresses: ${Object.keys(addrByEmail).length} distinct parent emails`);

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const school = (await pool.query(`SELECT ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag FROM schools WHERE id=$1`, [SCHOOL_ID])).rows[0];
const gh = axios.create({
  baseURL: 'https://services.leadconnectorhq.com',
  headers: { Authorization: `Bearer ${decryptPit(school.ghl_pit_encrypted, school.ghl_pit_iv, school.ghl_pit_tag)}`, Version: '2021-07-28', 'Content-Type': 'application/json' },
  timeout: 30000,
});

const cf = (await gh.get(`/locations/${school.ghl_location_id}/customFields`)).data;
const idByKey = new Map();
for (const f of cf.customFields ?? []) {
  const k = (f.fieldKey ?? '').replace(/^contact\./, '');
  if (k) idByKey.set(k, f.id);
}

// Students (active + withdrawn), slot-ordered per family.
const studs = (await pool.query(`
  SELECT id, family_id, first_name, last_name, date_of_birth, gender, status, metadata
    FROM students WHERE school_id=$1 AND status IN ('active','withdrawn')`, [SCHOOL_ID])).rows;
const parents = (await pool.query(`
  SELECT p.family_id, p.id, p.first_name, p.last_name, lower(p.email) email, p.ghl_contact_id
    FROM parents p JOIN families f ON f.id=p.family_id
   WHERE p.school_id=$1 AND p.status='active' AND f.status='active'
     AND p.ghl_contact_id IS NOT NULL AND p.family_id <> $2`, [SCHOOL_ID, DEMO_FAMILY_ID])).rows;

const studsByFamily = new Map();
for (const s of studs) {
  if (s.family_id === DEMO_FAMILY_ID) continue;
  const list = studsByFamily.get(s.family_id) ?? [];
  list.push(s);
  studsByFamily.set(s.family_id, list);
}
for (const list of studsByFamily.values()) {
  list.sort((a, b) =>
    (parseInt(a.metadata?.ghl_slot ?? '99', 10) - parseInt(b.metadata?.ghl_slot ?? '99', 10))
    || a.first_name.localeCompare(b.first_name));
}

// metadata key -> GHL slot base (same name unless noted). These are
// the Sonia-managed fields: pushed when set, CLEARED in GHL when the
// registrar's sheet left them blank — otherwise old GHL values survive
// and the GHL→dashboard propagation would resurrect them.
const MD_BASES = [
  'grade_level', 'program', 'homeroom', 'enrollment_status', 'program_name',
  'lead_teacher', 'daily_schedule', 'age', 'tuition_fee', 'program_tuition',
  'field_needed_for_tuition', 'extended_day', 'organic_lunch', 'payment_plan',
  'months_enrolled', 'graduation_year', 'financial_aid', 'allergy', 'iep',
  '504_plan', 'legal_authority', 'physical_custody', 'language', 'ethnicity',
  'apid', 'health_care_provider', 'health_care_provider_phone',
  'emergency_first_contact', 'referred_by', 'discount_type',
  'discount_percentage', 'admin_fee_percentage', 'withdrawal_fee',
];
const MD_DATE_BASES = [
  ['initial_start_date', 'initial_start_date'],
  ['enrollment_start_date', 'current_year_enrollment_start_date'],
  ['withdrawal_date', 'withdrawal_date'],
];
// GHL normalizes MONETARY fields (strips commas) — push pre-normalized
// so the round-trip is byte-identical.
const STRIP_COMMAS = new Set(['tuition_fee', 'field_needed_for_tuition', 'withdrawal_fee']);

console.log(`linked active parents: ${parents.length} · families with students: ${studsByFamily.size}`);
console.log(`mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}\n`);

let ok = 0, failed = 0, fieldsTotal = 0;
const missingKeys = new Set();
const slotPatches = new Map(); // student_id -> slot

for (const p of parents) {
  const kids = (studsByFamily.get(p.family_id) ?? []).slice(0, 4);
  const customFields = [];
  const push = (key, val) => {
    if (val == null || String(val).trim() === '') return;
    const id = idByKey.get(key);
    if (!id) { missingKeys.add(key); return; }
    customFields.push({ id, field_value: String(val) });
  };
  // Managed field: blank in the new truth -> clear it in GHL.
  const pushOrClear = (key, val) => {
    const id = idByKey.get(key);
    if (!id) { missingKeys.add(key); return; }
    customFields.push({ id, field_value: val == null ? '' : String(val) });
  };
  const hh = kids.find((k) => k.metadata?.household_id)?.metadata.household_id;
  push('household_id', hh);
  kids.forEach((k, i) => {
    const slot = i + 1;
    if (String(k.metadata?.ghl_slot ?? '') !== String(slot)) slotPatches.set(k.id, slot);
    const md = k.metadata ?? {};
    push(slotKey(slot, 'first_name'), k.first_name);
    push(slotKey(slot, 'last_name'), k.last_name);
    push(slotKey(slot, 'id'), md.unique_id);
    if (k.gender) push(slotKey(slot, 'gender'), k.gender);
    if (k.date_of_birth) {
      const dob = k.date_of_birth instanceof Date
        ? k.date_of_birth.toISOString().slice(0, 10)
        : String(k.date_of_birth).slice(0, 10);
      push(slotKey(slot, 'birth_date'), dob);
    }
    for (const base of MD_BASES) {
      let v = md[base];
      if (v != null && STRIP_COMMAS.has(base)) v = String(v).replace(/,/g, '');
      pushOrClear(slotKey(slot, base), v);
    }
    for (const [mdKey, base] of MD_DATE_BASES) pushOrClear(slotKey(slot, base), dateOnly(md[mdKey]));
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
    if (failed <= 6) console.warn(`  FAIL ${p.first_name} ${p.last_name}: ${e.response?.status ?? ''} ${JSON.stringify(e.response?.data ?? {}).slice(0, 140)}`);
  }
}
console.log(`${APPLY ? 'updated' : 'would update'} ${ok} contacts (${fieldsTotal} custom-field writes), failed ${failed}`);

// Persist slot assignments so GHL→metadata propagation maps correctly.
if (slotPatches.size) {
  if (APPLY) {
    for (const [sid, slot] of slotPatches) {
      await pool.query(
        `UPDATE students SET metadata = metadata || jsonb_build_object('ghl_slot', $2::int), updated_at=now() WHERE id=$1`,
        [sid, slot],
      );
    }
    console.log(`persisted ghl_slot on ${slotPatches.size} students`);
  } else {
    console.log(`would persist ghl_slot on ${slotPatches.size} students`);
  }
}
if (missingKeys.size) console.log('keys not in GHL catalog (skipped):', [...missingKeys].slice(0, 16).join(', '), missingKeys.size > 16 ? `… +${missingKeys.size - 16}` : '');
if (!APPLY) console.log('\nDRY-RUN — re-run with --apply.');
await pool.end();
