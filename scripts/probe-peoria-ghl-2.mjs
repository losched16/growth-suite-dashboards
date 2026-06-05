// Deeper probe: total contact count via search, breakdown by:
//   - 'I am a current family' checkbox = true
//   - pipeline stage (Enrolled / Documents Completed)
//   - tag distribution across ALL contacts

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(join(here, '..', '.env.local'), 'utf8');
for (const ln of envText.split(/\r?\n/)) {
  const m = ln.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (!m) continue;
  let v = m[2]; if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  process.env[m[1]] = v;
}

const PIT = 'pit-416d7c9b-1166-4355-82d7-266cddd06a7c';
const LOCATION_ID = 'cucEbOulc74TXTdHgL89';
const BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';

async function ghl(path, opts = {}) {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const r = await fetch(url, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${PIT}`,
      'Version': VERSION,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...(opts.headers ?? {}),
    },
  });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!r.ok) {
    console.error(`GHL ${r.status} ${path}:`, typeof body === 'string' ? body.slice(0, 400) : JSON.stringify(body).slice(0, 400));
    return null;
  }
  return body;
}

// Use the proper search endpoint and paginate
console.log('=== Full contact paginate via /contacts/search ===');
let allContacts = [];
let page = 1;
let startAfter = undefined;
let startAfterId = undefined;
while (true) {
  const body = {
    locationId: LOCATION_ID,
    pageLimit: 100,
  };
  if (startAfter && startAfterId) {
    body.searchAfter = [startAfter, startAfterId];
  }
  const r = await ghl('/contacts/search', { method: 'POST', body: JSON.stringify(body) });
  if (!r) break;
  const contacts = r.contacts ?? [];
  allContacts.push(...contacts);
  console.log(`  page ${page}: +${contacts.length}  (total so far: ${allContacts.length})  reported total=${r.total}`);
  if (contacts.length === 0) break;
  const last = contacts[contacts.length - 1];
  if (!last.dateAdded) break;
  startAfter = new Date(last.dateAdded).getTime();
  startAfterId = last.id;
  page++;
  if (page > 50) { console.log('  abort: > 50 pages'); break; }
  if (allContacts.length >= (r.total ?? 0)) break;
}

console.log(`\nTotal contacts pulled: ${allContacts.length}`);

// Get custom fields map
const cfRes = await ghl(`/locations/${LOCATION_ID}/customFields`);
const customFields = cfRes?.customFields ?? [];
const cfById = new Map(customFields.map((f) => [f.id, f]));
const cfKeyId = (key) => customFields.find((f) => f.fieldKey === `contact.${key}`)?.id;

const currentFamilyId = cfKeyId('i_am_a_current_family_or_attended_the_school_previously');
const parent1FirstId  = cfKeyId('parent1_first_name');
const studentFirstId  = cfKeyId('student_first_name');
const student2FirstId = cfKeyId('student_2_first_name');
const student3FirstId = cfKeyId('student_3_first_name');

console.log('\n=== Breakdown ===');
let currentFamilyCount = 0;
let hasParent1Count = 0;
let hasStudentCount = 0;
let withTwoStudents = 0;
let withThreeStudents = 0;
const tagCount = new Map();

// We need to pull full contact details to see custom field values.
// Fetch each contact's details (slow but accurate).
console.log('\n(Fetching full details for each contact to read custom-field values...)');
const enriched = [];
for (const c of allContacts) {
  const full = await ghl(`/contacts/${c.id}`);
  const ct = full?.contact;
  if (!ct) continue;
  enriched.push(ct);
  const cfMap = new Map();
  for (const v of (ct.customFields ?? [])) cfMap.set(v.id, v.value);
  if (currentFamilyId && cfMap.get(currentFamilyId)) currentFamilyCount++;
  if (parent1FirstId && cfMap.get(parent1FirstId)) hasParent1Count++;
  if (studentFirstId && cfMap.get(studentFirstId)) hasStudentCount++;
  if (student2FirstId && cfMap.get(student2FirstId)) withTwoStudents++;
  if (student3FirstId && cfMap.get(student3FirstId)) withThreeStudents++;
  for (const t of (ct.tags ?? [])) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
}

console.log(`\n'I am a current family' checked:  ${currentFamilyCount} / ${enriched.length}`);
console.log(`has parent1_first_name filled:    ${hasParent1Count}`);
console.log(`has student_first_name filled:    ${hasStudentCount}`);
console.log(`has student_2_first_name filled:  ${withTwoStudents}`);
console.log(`has student_3_first_name filled:  ${withThreeStudents}`);

console.log('\n=== Tag distribution (all contacts) ===');
const sortedTags = [...tagCount.entries()].sort((a, b) => b[1] - a[1]);
for (const [t, n] of sortedTags) console.log(`  ${n.toString().padStart(3, ' ')}x  ${t}`);

console.log('\n=== Pipeline / opportunities ===');
const plRes = await ghl(`/opportunities/pipelines?locationId=${LOCATION_ID}`);
const pipelines = plRes?.pipelines ?? [];
for (const p of pipelines) {
  console.log(`\n  Pipeline: ${p.name} (id=${p.id})`);
  for (const s of (p.stages ?? [])) {
    // count opps in this stage
    const opps = await ghl(`/opportunities/search?location_id=${LOCATION_ID}&pipeline_id=${p.id}&pipeline_stage_id=${s.id}&limit=100`);
    const oppCount = (opps?.opportunities ?? []).length;
    console.log(`    ${s.name}  (id=${s.id})  opps=${oppCount}`);
  }
}

// Show a few "current family = true" contacts in detail
console.log('\n=== Sample current-family contacts (up to 5) ===');
let shown = 0;
for (const ct of enriched) {
  const cfMap = new Map((ct.customFields ?? []).map((v) => [v.id, v.value]));
  if (!currentFamilyId || !cfMap.get(currentFamilyId)) continue;
  if (shown >= 5) break;
  console.log(`\n  ${ct.firstName} ${ct.lastName} <${ct.email ?? ''}>  ph=${ct.phone ?? ''}`);
  console.log(`    tags: ${(ct.tags ?? []).join(', ')}`);
  for (const [id, val] of cfMap) {
    const field = cfById.get(id);
    if (!field) continue;
    if (val === '' || val == null) continue;
    let v = typeof val === 'string' && val.length > 80 ? val.slice(0, 80) + '…' : val;
    console.log(`    cf: ${field.name} = ${JSON.stringify(v)}`);
  }
  shown++;
}

console.log('\nDone.');
