// Peoria Montessori sync compatibility setup.
//
// Makes Peoria's GHL location compatible with the GHL → DB sync so
// running the cron rebuilds 41 current-parent families instead of
// blowing them away. Three phases:
//
//   1. Ensure the 5 GHL custom fields the sync needs (and only the
//      ones missing — Peoria already has Parent1, Student First/Last
//      ×3 from its inquiry form):
//        - Household ID            (clustering key — REQUIRED)
//        - Parent 2 First Name
//        - Parent 2 Last Name
//        - Parent 2 Email
//        - Parent 2 Phone
//
//   2. Re-read the Current_parents_email.csv and Other Mail. csv, build
//      the family clusters (same logic as import-peoria.mjs), then on
//      each current-parent GHL contact:
//        - Stamp Household ID:
//            * Solo parent  → Household ID = contact.id
//            * Couple       → Household ID = primary's contact.id
//                             (both spouses share it; spouse #2 also
//                             gets the SAME household_id stamped)
//        - On the primary, fill Parent 2 First/Last/Email/Phone with
//          the spouse's data (so the sync knows the second parent
//          exists without needing a second contact row).
//
//   3. Upsert Peoria's school_field_schemas row mapping the abstract
//      field names to Peoria's actual GHL field keys, and flip
//      allow_parent_only_families = TRUE so the sync keeps the 41
//      families even though they have no student rows in GHL yet.
//
// After this runs, the next cron tick (or a manual
// runGhlSync(peoria)) should rebuild the 41 families cleanly.
//
// USAGE:
//   node scripts/setup-peoria-sync.mjs
//   node scripts/setup-peoria-sync.mjs --dry-run
//
// Idempotent: re-running stamps the same household_ids and updates
// the school_field_schemas row in place.

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(join(here, '..', '.env.local'), 'utf8');
for (const ln of envText.split(/\r?\n/)) {
  const m = ln.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (!m) continue;
  let v = m[2]; if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  process.env[m[1]] = v;
}

const DRY = process.argv.includes('--dry-run');

const PIT = 'pit-416d7c9b-1166-4355-82d7-266cddd06a7c';
const LOCATION_ID = 'cucEbOulc74TXTdHgL89';
const SCHOOL_ID = 'b0018576-be12-42ed-aaa7-6248e2756cf6';
const BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';

const DL = 'C:\\Users\\thelo\\Downloads';

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
  if (!r.ok) return { ok: false, status: r.status, body };
  return { ok: true, body };
}

// ── CSV parser (same as import-peoria.mjs) ────────────────────────────
function parseCsv(text) {
  const rows = []; let cur = []; let field = ''; let inQuote = false; let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (ch === '"') { inQuote = false; i++; continue; }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuote = true; i++; continue; }
    if (ch === ',') { cur.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; i++; continue; }
    field += ch; i++;
  }
  if (field !== '' || cur.length) { cur.push(field); rows.push(cur); }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0]));
}

// ── Phase 1: ensure 5 custom fields exist ─────────────────────────────
const REQUIRED_FIELDS = [
  { name: 'Household ID',          fieldKeyHint: 'household_id'       },
  { name: 'Parent 2 First Name',   fieldKeyHint: 'parent_2_first_name'},
  { name: 'Parent 2 Last Name',    fieldKeyHint: 'parent_2_last_name' },
  { name: 'Parent 2 Email',        fieldKeyHint: 'parent_2_email'     },
  { name: 'Parent 2 Phone',        fieldKeyHint: 'parent_2_phone'     },
];

console.log('── Phase 1: ensure custom fields ──');
const cfRes = await ghl(`/locations/${LOCATION_ID}/customFields`);
if (!cfRes.ok) { console.error('Failed to list custom fields:', cfRes.body); process.exit(1); }
const existing = cfRes.body.customFields ?? [];
const existingByName = new Map(existing.map((f) => [f.name.toLowerCase(), f]));

const fieldIdByAbstract = {};
for (const want of REQUIRED_FIELDS) {
  const ex = existingByName.get(want.name.toLowerCase());
  if (ex) {
    fieldIdByAbstract[want.fieldKeyHint] = ex.id;
    console.log(`  exists: ${want.name}  → ${ex.fieldKey ?? ex.key}  (id=${ex.id})`);
    continue;
  }
  if (DRY) { console.log(`  would create: ${want.name}`); continue; }
  const c = await ghl(`/locations/${LOCATION_ID}/customFields`, {
    method: 'POST',
    body: JSON.stringify({
      name: want.name,
      dataType: 'TEXT',
      model: 'contact',
    }),
  });
  if (!c.ok) { console.error(`  CREATE FAILED ${want.name}:`, c.body); continue; }
  const created = c.body.customField ?? c.body;
  fieldIdByAbstract[want.fieldKeyHint] = created.id;
  console.log(`  created: ${want.name}  → ${created.fieldKey ?? created.key}  (id=${created.id})`);
}

// Also capture existing Peoria fields we care about for the schema map
const fieldByName = new Map();
const cf2 = (await ghl(`/locations/${LOCATION_ID}/customFields`)).body?.customFields ?? [];
for (const f of cf2) fieldByName.set(f.name.toLowerCase().trim(), f);
const peoriaFieldKey = (humanName, fallback) => {
  const f = fieldByName.get(humanName.toLowerCase().trim());
  if (!f) return fallback ?? null;
  // The sync's getField uses bare fieldKey (no "contact." prefix).
  const key = (f.fieldKey ?? f.key ?? '').replace(/^contact\./, '');
  return key || fallback || null;
};

// ── Phase 2: re-cluster current parents from CSV, stamp household_ids ─
console.log('\n── Phase 2: re-cluster + stamp household IDs ──');
const cpText = readFileSync(join(DL, 'Current_parents_email.csv'), 'utf8');
const cpRows = parseCsv(cpText);
const cpHeader = cpRows[0].map((h) => h.toLowerCase().trim());
const emailIdx     = cpHeader.findIndex((h) => h === 'email address');
const firstIdx     = cpHeader.findIndex((h) => h === 'first name');
const lastIdx      = cpHeader.findIndex((h) => h === 'last name');
const tagsIdx      = cpHeader.findIndex((h) => h === 'tags');
const classroomIdx = cpHeader.findIndex((h) => h === 'classrooms');

const currentParents = [];
for (let r = 1; r < cpRows.length; r++) {
  const row = cpRows[r];
  if (!row || row.length < 2) continue;
  const email = (row[emailIdx] ?? '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
  const tagsRaw = tagsIdx >= 0 ? (row[tagsIdx] ?? '') : '';
  const isStaff = email.endsWith('@peoriamontessori.org')
    || tagsRaw.toLowerCase().includes('staff');
  if (isStaff) continue;     // staff aren't parents
  currentParents.push({
    email,
    firstName: (row[firstIdx] ?? '').trim(),
    lastName:  (row[lastIdx]  ?? '').trim(),
    classroom: classroomIdx >= 0 ? (row[classroomIdx] ?? '').trim() : '',
  });
}
console.log(`  current parents to process: ${currentParents.length}`);

// Pull every GHL contact so we can match by email → contact.id
const all = [];
{
  let startAfter, startAfterId;
  for (let p = 0; p < 50; p++) {
    const body = { locationId: LOCATION_ID, pageLimit: 100 };
    if (startAfter && startAfterId) body.searchAfter = [startAfter, startAfterId];
    const r = await ghl('/contacts/search', { method: 'POST', body: JSON.stringify(body) });
    if (!r.ok) { console.error('contacts/search failed:', r.body); break; }
    const list = r.body.contacts ?? [];
    if (!list.length) break;
    all.push(...list);
    const last = list[list.length - 1];
    startAfter = new Date(last.dateAdded).getTime();
    startAfterId = last.id;
    if (all.length >= (r.body.total ?? 0)) break;
  }
}
console.log(`  total GHL contacts pulled: ${all.length}`);
const contactByEmail = new Map();
for (const c of all) if (c.email) contactByEmail.set(c.email.toLowerCase(), c);

// Cluster by last name (same as import-peoria.mjs)
const byLast = new Map();
for (const p of currentParents) {
  const ln = (p.lastName || '').toLowerCase();
  if (!ln) continue;
  if (!byLast.has(ln)) byLast.set(ln, []);
  byLast.get(ln).push(p);
}

let stampCount = 0, stampSkip = 0, stampFail = 0;
let parent2Filled = 0;

for (const [_ln, members] of byLast) {
  // Pick primary: first member with a matching GHL contact, else first
  let primary = null;
  for (const m of members) {
    if (contactByEmail.has(m.email)) { primary = m; break; }
  }
  if (!primary) primary = members[0];
  const primaryContact = contactByEmail.get(primary.email);
  if (!primaryContact) {
    console.log(`  no GHL contact for primary ${primary.email} — skip family ${members[0].lastName}`);
    continue;
  }
  const householdId = primaryContact.id;

  // Stamp Household ID on every member of this family, and fill
  // Parent 2 fields on the primary if there's a second member.
  const second = members.find((m) => m.email !== primary.email);

  // Build the custom-field patch for the primary
  const primaryFields = [
    { id: fieldIdByAbstract.household_id, value: householdId },
  ];
  if (second) {
    primaryFields.push(
      { id: fieldIdByAbstract.parent_2_first_name, value: second.firstName || '' },
      { id: fieldIdByAbstract.parent_2_last_name,  value: second.lastName  || '' },
      { id: fieldIdByAbstract.parent_2_email,      value: second.email     || '' },
      { id: fieldIdByAbstract.parent_2_phone,      value: '' },
    );
    parent2Filled++;
  }

  if (!DRY) {
    const u = await ghl(`/contacts/${primaryContact.id}`, {
      method: 'PUT',
      body: JSON.stringify({ customFields: primaryFields }),
    });
    if (u.ok) stampCount++; else { stampFail++; console.error(`  stamp fail ${primaryContact.id}:`, u.body); }
  } else {
    stampCount++;
  }

  // Stamp Household ID on the second member's contact too (so both
  // contacts cluster). The sync only imports families from contacts
  // that HAVE household_id, so all parents in a household need it.
  if (second) {
    const secondContact = contactByEmail.get(second.email);
    if (secondContact && secondContact.id !== primaryContact.id) {
      if (!DRY) {
        const u2 = await ghl(`/contacts/${secondContact.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            customFields: [{ id: fieldIdByAbstract.household_id, value: householdId }],
          }),
        });
        if (!u2.ok) { stampFail++; console.error(`  stamp fail2 ${secondContact.id}:`, u2.body); }
        else stampCount++;
      } else {
        stampCount++;
      }
    }
  }
}

// Orphans — current parents with no last name → stamp them solo
for (const m of currentParents) {
  if (m.lastName) continue;
  const ct = contactByEmail.get(m.email);
  if (!ct) continue;
  if (!DRY) {
    const u = await ghl(`/contacts/${ct.id}`, {
      method: 'PUT',
      body: JSON.stringify({ customFields: [{ id: fieldIdByAbstract.household_id, value: ct.id }] }),
    });
    if (u.ok) stampCount++; else { stampFail++; console.error(`  stamp fail orphan ${ct.id}:`, u.body); }
  } else { stampCount++; }
}

console.log(`  stamped: ${stampCount}  parent2-filled: ${parent2Filled}  failures: ${stampFail}`);

// ── Phase 3: upsert school_field_schemas with allow_parent_only_families ─
console.log('\n── Phase 3: school_field_schemas ──');
const { Client } = pg;
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

// Build the field-schema mapping using Peoria's actual GHL fieldKeys.
// `peoriaFieldKey(humanName, fallback)` returns the bare key
// (no "contact." prefix) for the matching GHL field, or the fallback.
const familyFields = {
  householdId:      peoriaFieldKey('Household ID', 'household_id'),
  // Peoria doesn't have these — leave the DG defaults (loader merges).
  // householdPhone, parentsCombined, language, activeStatus
};
const parent2Fields = {
  firstName: peoriaFieldKey('Parent 2 First Name', 'parent_2_first_name'),
  lastName:  peoriaFieldKey('Parent 2 Last Name',  'parent_2_last_name'),
  email:     peoriaFieldKey('Parent 2 Email',      'parent_2_email'),
  phone:     peoriaFieldKey('Parent 2 Phone',      'parent_2_phone'),
};
// Peoria DOES have these student slot 1/2/3 fields from its inquiry form
const studentFields = {
  firstName: peoriaFieldKey('Student First Name', 'student_first_name'),
  lastName:  peoriaFieldKey('Student Last Name',  'student_last_name'),
  // Slot 2/3 first/last
  // Peoria has "Student 2 First Name" not "Student 2 First Name" — exact spelling
};

if (DRY) {
  console.log('  (dry run) Would write schema:');
  console.log('    family_fields:', familyFields);
  console.log('    parent2_fields:', parent2Fields);
  console.log('    student_fields:', studentFields);
  console.log('    allow_parent_only_families: TRUE');
} else {
  await c.query(
    `INSERT INTO school_field_schemas
       (school_id, family_fields, parent2_fields, student_fields,
        max_student_slots, default_academic_year, notes,
        allow_parent_only_families)
     VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, 3, '2026-27', $5, TRUE)
     ON CONFLICT (school_id) DO UPDATE SET
       family_fields = EXCLUDED.family_fields,
       parent2_fields = EXCLUDED.parent2_fields,
       student_fields = EXCLUDED.student_fields,
       max_student_slots = EXCLUDED.max_student_slots,
       default_academic_year = EXCLUDED.default_academic_year,
       notes = EXCLUDED.notes,
       allow_parent_only_families = EXCLUDED.allow_parent_only_families`,
    [
      SCHOOL_ID,
      JSON.stringify(familyFields),
      JSON.stringify(parent2Fields),
      JSON.stringify(studentFields),
      'Peoria onboarding — parents-only roster. allow_parent_only_families=TRUE so the GHL sync keeps the family graph even though student data lives outside GHL today. Once Peoria backfills Student fields per contact (or attaches an Admissions opportunity), students will start appearing in dashboards automatically.',
    ],
  );
  console.log('  school_field_schemas row upserted with allow_parent_only_families=TRUE');
}

await c.end();
console.log('\nDone.');
