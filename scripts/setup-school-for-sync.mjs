// Prepares a brand-new school's GHL location so the run-ghl-sync can
// pull contacts into families/parents/students cleanly.
//
// Three steps, all idempotent:
//   1. Ensures a "Household ID" custom field exists on the location.
//   2. Stamps household_id = contact.id on every contact in the location
//      (so the sync recognizes them as enrolled families).
//   3. Upserts a school_field_schemas row mapping the sync's abstract
//      field names → the actual GHL field keys we created.
//
// USAGE:
//   node scripts/setup-school-for-sync.mjs \
//     --location <ghl_location_id> --pit <pit_token>
//
// School row must already exist in `schools` (run provision-school.mjs
// first). The location_id is the lookup key.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// Load .env.local
const envText = readFileSync(join(projectRoot, '.env.local'), 'utf8');
for (const line of envText.split('\n')) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('='); if (eq === -1) continue;
  if (!process.env[t.slice(0, eq).trim()]) process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}

const LOCATION_ID = arg('location');
const PIT = arg('pit');
if (!LOCATION_ID || !PIT) {
  console.error('Usage: node scripts/setup-school-for-sync.mjs --location <id> --pit <token>');
  process.exit(2);
}

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';
const HOUSEHOLD_ID_FIELD_NAME = 'Household ID';

const ghlHeaders = {
  Authorization: `Bearer ${PIT}`,
  Version: GHL_VERSION,
  Accept: 'application/json',
  'Content-Type': 'application/json',
};

async function ghlGet(path) {
  const r = await fetch(`${GHL_BASE}${path}`, { headers: ghlHeaders });
  if (!r.ok) throw new Error(`${r.status} GET ${path}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}
async function ghlPost(path, body) {
  const r = await fetch(`${GHL_BASE}${path}`, { method: 'POST', headers: ghlHeaders, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${r.status} POST ${path}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}
async function ghlPut(path, body) {
  const r = await fetch(`${GHL_BASE}${path}`, { method: 'PUT', headers: ghlHeaders, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${r.status} PUT ${path}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

// ────────────────────────────────────────────────────────────────────
// Step 1: Ensure Household ID custom field exists
// ────────────────────────────────────────────────────────────────────
async function ensureHouseholdIdField() {
  const data = await ghlGet(`/locations/${LOCATION_ID}/customFields`);
  const fields = data.customFields ?? [];
  const existing = fields.find((f) => (f.name || '').toLowerCase() === HOUSEHOLD_ID_FIELD_NAME.toLowerCase());
  if (existing) {
    console.log(`  ✓ "${HOUSEHOLD_ID_FIELD_NAME}" already exists  (id=${existing.id})`);
    return { id: existing.id, fieldKey: existing.fieldKey || existing.key, fields };
  }
  console.log(`  + Creating "${HOUSEHOLD_ID_FIELD_NAME}" (TEXT)...`);
  const created = await ghlPost(`/locations/${LOCATION_ID}/customFields`, {
    name: HOUSEHOLD_ID_FIELD_NAME,
    dataType: 'TEXT',
    model: 'contact',
  });
  const cf = created.customField || created;
  console.log(`  ✓ Created  (id=${cf.id}, key=${cf.fieldKey || cf.key})`);
  // Re-fetch the list so we have it post-create.
  const refreshed = await ghlGet(`/locations/${LOCATION_ID}/customFields`);
  return { id: cf.id, fieldKey: cf.fieldKey || cf.key, fields: refreshed.customFields ?? [] };
}

// ────────────────────────────────────────────────────────────────────
// Step 2: List all contacts + stamp household_id = contact.id
// ────────────────────────────────────────────────────────────────────
async function listAllContacts() {
  const all = [];
  let page = 1;
  for (;;) {
    const data = await ghlPost('/contacts/search', {
      locationId: LOCATION_ID,
      pageLimit: 100,
      page,
    });
    const batch = data.contacts ?? [];
    all.push(...batch);
    if (batch.length < 100) break;
    page += 1;
    if (page > 50) break; // hard cap
  }
  return all;
}

async function stampHouseholdIds(contacts, fieldId) {
  let stamped = 0, alreadyStamped = 0, failed = 0;
  for (let i = 0; i < contacts.length; i++) {
    const c = contacts[i];
    const existing = (c.customFields ?? []).find((cf) => cf.id === fieldId);
    if (existing && String(existing.value || '').trim() === c.id) {
      alreadyStamped++;
      continue;
    }
    try {
      await ghlPut(`/contacts/${c.id}`, {
        customFields: [{ id: fieldId, value: c.id }],
      });
      stamped++;
      // small throttle so we don't hammer GHL
      if (stamped % 10 === 0) console.log(`  ... ${stamped} stamped / ${contacts.length} total`);
      await new Promise((r) => setTimeout(r, 100));
    } catch (e) {
      console.log(`  FAIL  ${c.id} (${c.email || '(no email)'}): ${e.message}`);
      failed++;
    }
  }
  console.log(`  ✓ Stamped ${stamped}, already-correct ${alreadyStamped}, failed ${failed}`);
  return { stamped, alreadyStamped, failed };
}

// ────────────────────────────────────────────────────────────────────
// Step 3: Upsert school_field_schemas row
// ────────────────────────────────────────────────────────────────────
//
// Inspects the actual custom fields on the location and figures out
// which ones map to the abstract field names the sync expects. Saves
// a school-specific config so the sync uses the right keys.
function deriveFieldKeyMap(fields) {
  // Build a normalized-name → fieldKey map (strip 'contact.' prefix)
  const byNorm = new Map();
  for (const f of fields) {
    const n = (f.name || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const k = (f.fieldKey || f.key || '').replace(/^contact\./, '');
    if (n) byNorm.set(n, k);
  }
  // For each abstract name we care about, pick the matching field key.
  // Returns the key (snake_case) — the sync resolves to ID via the schema fetch.
  return {
    family: {
      householdId: byNorm.get('household id') || 'household_id',
    },
    parent2: {
      firstName: byNorm.get('parent 2 first name') || 'parent_2_first_name',
      lastName:  byNorm.get('parent 2 last name')  || 'parent_2_last_name',
      email:     byNorm.get('parent 2 email')      || 'parent_2_email',
      phone:     byNorm.get('parent 2 phone')      || 'parent_2_phone',
    },
    student: {
      // The slot-1 field for "Student First Name" is just "Student First Name"
      // — its key is `student_first_name`. studentFieldKey() prefixes with
      // `student_` for slot 1, so we pass the base ("first_name") so the
      // resulting key is `student_first_name` ✓.
      //
      // Higher slots: studentFieldKey(2, 'first_name') = `student_2_first_name` ✓.
      firstName:     'first_name',
      lastName:      'last_name',
      birthDate:     'dob',           // We named ours "Student DOB" → key student_dob
      gradeLevel:    'grade',
      homeroom:      'classroom',
      dailySchedule: 'schedule_days', // closest match
      allergy:       'allergies',
      // The sync also reads these but we don't have them — leaving empty
      // tells the captureAllContactFieldsForSlot() catch-all to pick up
      // any other student-scoped fields automatically.
    },
  };
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function upsertSchema(schoolId, mapping) {
  await pool.query(
    `INSERT INTO school_field_schemas
       (school_id, family_fields, parent2_fields, student_fields,
        max_student_slots, default_academic_year, notes)
     VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5, $6, $7)
     ON CONFLICT (school_id) DO UPDATE SET
       family_fields  = EXCLUDED.family_fields,
       parent2_fields = EXCLUDED.parent2_fields,
       student_fields = EXCLUDED.student_fields,
       max_student_slots = EXCLUDED.max_student_slots,
       default_academic_year = EXCLUDED.default_academic_year,
       notes = EXCLUDED.notes`,
    [
      schoolId,
      JSON.stringify(mapping.family),
      JSON.stringify(mapping.parent2),
      JSON.stringify(mapping.student),
      3, // 3 student slots configured in this location
      '2026-27',
      'Auto-configured by setup-school-for-sync.mjs. Field keys match this location\'s actual custom field names.',
    ],
  );
}

// ────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────
try {
  // Resolve school_id from location
  const { rows } = await pool.query(
    `SELECT id, name FROM schools WHERE ghl_location_id = $1`,
    [LOCATION_ID],
  );
  if (rows.length === 0) {
    throw new Error(`No school with location_id ${LOCATION_ID}. Run provision-school.mjs first.`);
  }
  const school = rows[0];
  console.log(`Target school: ${school.name} (${school.id})`);
  console.log();

  console.log('Step 1: Ensure "Household ID" custom field exists');
  const { id: householdFieldId, fields } = await ensureHouseholdIdField();
  console.log();

  console.log('Step 2: List contacts + stamp household_id on each');
  const contacts = await listAllContacts();
  console.log(`  Found ${contacts.length} contact(s) on the location.`);
  await stampHouseholdIds(contacts, householdFieldId);
  console.log();

  console.log('Step 3: Upsert school_field_schemas row');
  const mapping = deriveFieldKeyMap(fields);
  await upsertSchema(school.id, mapping);
  console.log(`  ✓ Saved mapping:`);
  console.log(`    family.householdId = ${mapping.family.householdId}`);
  console.log(`    parent2.firstName  = ${mapping.parent2.firstName}`);
  console.log(`    student.birthDate  = ${mapping.student.birthDate}`);
  console.log(`    student.gradeLevel = ${mapping.student.gradeLevel}`);
  console.log(`    student.homeroom   = ${mapping.student.homeroom}`);
  console.log();

  console.log('='.repeat(60));
  console.log('  Done. Ready for sync.');
  console.log('='.repeat(60));
  console.log(`  Trigger sync with:`);
  console.log(`    curl -X POST https://growth-suite-dashboards.vercel.app/api/admin/schools/${school.id}/sync-from-ghl`);
  console.log('='.repeat(60));
} catch (e) {
  console.error('FAILED:', e.message);
  process.exit(1);
} finally {
  await pool.end();
}
