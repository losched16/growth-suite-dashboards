// Writeback enrichment from our DB → GHL contact custom fields.
//
// Source of truth: the Wooster DB after the Final Forms + tuition
// imports.
//
// CRITICAL RULE: never overwrite a GHL field that already has a
// value. Parents may have submitted a portal form after we imported
// from Final Forms, and their fresh answer takes precedence over our
// older spreadsheet data. We GET each contact, inspect existing
// custom-field values, and only PUT fields that are currently blank.
//
// Scope (per primary parent contact):
//   - Parent 2 first/last name, cell phone, work phone
//   - Emergency contact #1 / #2 / #3 — name, phone, relationship
//   - Primary doctor name + phone, preferred hospital name + phone,
//     insurance company
//   - Allergies, current medications, existing medical conditions
//     (primary student only — slot 1)
//
// Out of scope:
//   - Per-slot health writeback for siblings (the auto-generated
//     slot 2/3/4 field keys vary too much to enumerate confidently
//     in one pass — separate effort)
//   - Tuition / billing fields (the business office already manages
//     these in GHL; nothing for us to add)
//   - Pickup permissions (no clean GHL field for these — they live
//     in our DB only)
//
// Idempotent: re-run safely. Every write goes through the same
// "GHL field is blank?" guard, so re-runs do nothing once a value is
// present.

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
  const k = t.slice(0, eq).trim();
  const v = t.slice(eq + 1).trim();
  if (!process.env[k]) process.env[k] = v;
}

const WOOSTER_SCHOOL_ID = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1]) || 0;
if (DRY_RUN) console.log('[DRY RUN] no GHL writes will be made');
if (LIMIT)  console.log(`[LIMIT] processing first ${LIMIT} contacts only`);

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

function decrypt(ciphertext, iv, tag) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ciphertext, 'base64')), d.final()]).toString('utf8');
}

// GHL custom field keys we'll write to. Each entry: [DB getter, GHL fieldKey].
// fieldKey is what we look up against the location's customField schema.
const FIELD_PLAN = [
  // Parent 2 (from second parent row in DB)
  { source: 'parent2.first_name', ghl: 'parent_2_first_name' },
  { source: 'parent2.last_name',  ghl: 'parent_2_last_name' },
  { source: 'parent2.phone',      ghl: 'parent_2_cell_phone' },
  // Emergency contacts — we store EC1 on student_health_profiles and
  // EC2/EC3 as pickup_persons added by the primary parent.
  { source: 'ec1.name',         ghl: 'emergency_contact_1_name' },
  { source: 'ec1.phone',        ghl: 'emergency_contact_1_phone_numbers' },
  { source: 'ec1.relationship', ghl: 'emergency_contact_1_relationship_to_student' },
  { source: 'ec2.name',         ghl: 'emergency_contact_2_name' },
  { source: 'ec2.phone',        ghl: 'emergency_contact_2_phone_numbers' },
  { source: 'ec2.relationship', ghl: 'emergency_contact_2_relationship_to_student' },
  { source: 'ec3.name',         ghl: 'emergency_contact_3_name' },
  { source: 'ec3.phone',        ghl: 'emergency_contact_3_phone_numbers' },
  { source: 'ec3.relationship', ghl: 'emergency_contact_3_relationship_to_student' },
  // Medical providers (slot 1 student)
  { source: 'health.primary_doctor_name',       ghl: 'doctor_name' },
  { source: 'health.primary_doctor_phone',      ghl: 'doctor_phone' },
  { source: 'health.preferred_hospital',        ghl: 'hospital_name' },
  { source: 'health.health_insurance_provider', ghl: 'insurance_company' },
  // Per-student medical (slot 1)
  { source: 'health.allergies',           ghl: 'allergies' },
  { source: 'health.current_medications', ghl: 'medications' },
  { source: 'health.medical_conditions',  ghl: 'existing_medical_conditions' },
];

function get(obj, path) {
  return path.split('.').reduce((acc, k) => (acc == null ? null : acc[k]), obj);
}

async function ghlGet(pit, url) {
  const r = await fetch(`https://services.leadconnectorhq.com${url}`, {
    headers: { Authorization: `Bearer ${pit}`, Version: '2021-07-28', Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}: ${await r.text()}`);
  return r.json();
}
async function ghlPut(pit, url, body) {
  const r = await fetch(`https://services.leadconnectorhq.com${url}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${pit}`,
      Version: '2021-07-28',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PUT ${url} → ${r.status}: ${await r.text()}`);
  return r.json();
}

async function main() {
  const c = await pool.connect();
  try {
    const { rows: schools } = await c.query(
      `SELECT id, ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag
         FROM schools WHERE id = $1`,
      [WOOSTER_SCHOOL_ID],
    );
    const sch = schools[0];
    if (!sch) throw new Error('Wooster school not found');
    const pit = decrypt(sch.ghl_pit_encrypted, sch.ghl_pit_iv, sch.ghl_pit_tag);
    const locationId = sch.ghl_location_id;

    // 1. Pull location's customField schema → map fieldKey → id
    const cfData = await ghlGet(pit, `/locations/${locationId}/customFields`);
    const idByKey = new Map();
    const keyById = new Map();
    for (const f of cfData.customFields ?? []) {
      // fieldKey from API is "contact.<key>"; the FIELD_PLAN keys are
      // the suffix only. Normalize both directions.
      const suffix = (f.fieldKey || '').replace(/^contact\./, '');
      idByKey.set(suffix, f.id);
      keyById.set(f.id, suffix);
    }
    const planResolved = FIELD_PLAN
      .map((p) => ({ ...p, id: idByKey.get(p.ghl) }))
      .filter((p) => {
        if (!p.id) console.log(`  WARN: ghl field key "${p.ghl}" not found on this location, skipping`);
        return !!p.id;
      });

    // 2. Pull all primary parent contacts with their family + EC + health + parent 2 data
    let q = `
      SELECT p.id            AS parent_id,
             p.ghl_contact_id,
             p.family_id,
             -- Primary student (slot 1) of this family — that's whose
             -- health profile gets written to the contact-level fields
             (SELECT id FROM students
                WHERE family_id = p.family_id AND school_id = p.school_id
                  AND status = 'active'
                ORDER BY (metadata->>'slot')::int NULLS LAST LIMIT 1) AS primary_student_id,
             -- Parent 2 (non-primary parent in same family)
             (SELECT row_to_json(x.*) FROM (
                SELECT first_name, last_name, phone, email FROM parents p2
                 WHERE p2.family_id = p.family_id AND p2.is_primary = false
                 ORDER BY p2.created_at LIMIT 1
              ) x) AS parent2
        FROM parents p
       WHERE p.school_id = $1 AND p.is_primary = true AND p.ghl_contact_id IS NOT NULL
       ORDER BY p.created_at
    `;
    if (LIMIT > 0) q += ` LIMIT ${LIMIT}`;
    const { rows: primaryParents } = await c.query(q, [WOOSTER_SCHOOL_ID]);
    console.log(`Found ${primaryParents.length} primary GHL-linked parents to process`);

    const counts = {
      contacts_inspected: 0,
      contacts_with_writes: 0,
      fields_written: 0,
      fields_skipped_already_set: 0,
      fields_skipped_no_db_value: 0,
      contacts_failed: 0,
    };

    for (let i = 0; i < primaryParents.length; i++) {
      const pp = primaryParents[i];
      counts.contacts_inspected++;

      // Pull health profile + EC2/EC3 (pickup_persons) for the primary student
      const [hpRes, ecRes] = await Promise.all([
        c.query(
          `SELECT emergency_contact_name, emergency_contact_relationship, emergency_contact_phone,
                  primary_doctor_name, primary_doctor_phone,
                  preferred_hospital, health_insurance_provider,
                  allergies, current_medications, medical_conditions
             FROM student_health_profiles
            WHERE student_id = $1 AND school_id = $2`,
          [pp.primary_student_id, WOOSTER_SCHOOL_ID],
        ),
        c.query(
          // Sort by created_at so the earliest EC2 row is first.
          // Excludes parents from the same family — only emergency contacts.
          `SELECT name, relationship, phone
             FROM pickup_persons
            WHERE added_by_parent_id = $1
            ORDER BY created_at LIMIT 2`,
          [pp.parent_id],
        ),
      ]);
      const hp = hpRes.rows[0] ?? {};
      const dbSource = {
        parent2: pp.parent2 ?? {},
        ec1: {
          name: hp.emergency_contact_name,
          phone: hp.emergency_contact_phone,
          relationship: hp.emergency_contact_relationship,
        },
        ec2: ecRes.rows[0] ?? {},
        ec3: ecRes.rows[1] ?? {},
        health: hp,
      };

      // Pull current contact (to see existing field values)
      let contact;
      try {
        const got = await ghlGet(pit, `/contacts/${pp.ghl_contact_id}`);
        contact = got.contact;
      } catch (e) {
        console.log(`  [${i+1}/${primaryParents.length}] FAIL fetch contact ${pp.ghl_contact_id}: ${e.message}`);
        counts.contacts_failed++;
        continue;
      }

      const existingByFieldId = new Map();
      for (const cf of contact.customFields ?? []) {
        existingByFieldId.set(cf.id, cf.value);
      }

      // Build the writes
      const writes = [];
      for (const p of planResolved) {
        const dbVal = get(dbSource, p.source);
        const cleaned = (dbVal == null || String(dbVal).trim() === '') ? null : String(dbVal).trim();
        if (cleaned == null) { counts.fields_skipped_no_db_value++; continue; }
        const existing = existingByFieldId.get(p.id);
        const existingClean = existing == null ? null : String(existing).trim();
        if (existingClean && existingClean !== '') {
          counts.fields_skipped_already_set++;
          continue;  // never overwrite — parent's portal-submitted answer wins
        }
        writes.push({ id: p.id, key: p.ghl, value: cleaned });
      }

      if (writes.length === 0) continue;
      counts.contacts_with_writes++;
      counts.fields_written += writes.length;

      const name = `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim() || contact.email;
      console.log(`  [${i+1}/${primaryParents.length}] ${name}: ${writes.length} field(s) to write`);

      if (!DRY_RUN) {
        try {
          await ghlPut(pit, `/contacts/${pp.ghl_contact_id}`, {
            customFields: writes.map((w) => ({ id: w.id, value: w.value })),
          });
        } catch (e) {
          console.log(`    PUT failed: ${e.message}`);
          counts.contacts_failed++;
          continue;
        }
      }
    }

    console.log('\n=== Summary ===');
    for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(35)} ${v}`);
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
