// Wooster-specific GHL → family-graph sync.
//
// Wooster doesn't use the household_id family pattern (where multiple
// parent contacts share one household_id and we group them into one
// family). Each Wooster GHL contact = one parent = one family. Students
// live as slot fields on the contact (student_first_name,
// student_2_first_name, etc.).
//
// Snapshot semantics: deletes Wooster's existing family-graph rows and
// re-inserts from GHL. Re-runnable.
//
// Usage:
//   node scripts/sync-wooster-from-ghl.mjs

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

const WOOSTER_SCHOOL_ID = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
const ENROLLMENT_TAG = 'enrolled - 26/27';
const ACADEMIC_YEAR = '2026-27';
const MAX_SLOTS = 4;

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function decrypt(ciphertext, iv, tag) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

async function loadPit() {
  const r = await pool.query(
    `SELECT ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag
     FROM schools WHERE id = $1`,
    [WOOSTER_SCHOOL_ID],
  );
  if (r.rowCount === 0) throw new Error('Wooster school row not found');
  const row = r.rows[0];
  return {
    locationId: row.ghl_location_id,
    pit: decrypt(row.ghl_pit_encrypted, row.ghl_pit_iv, row.ghl_pit_tag),
  };
}

async function fetchFieldSchema(pit, locationId) {
  const res = await fetch(`${GHL_BASE}/locations/${locationId}/customFields`, {
    headers: {
      Authorization: `Bearer ${pit}`,
      Version: GHL_VERSION,
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`fetch customFields failed: ${res.status}`);
  const data = await res.json();
  const map = new Map();
  for (const f of data.customFields ?? []) {
    const raw = f.fieldKey ?? f.key;
    if (!raw || !f.id) continue;
    const normalized = raw.startsWith('contact.') ? raw.slice('contact.'.length) : raw;
    map.set(normalized, f.id);
  }
  return map;
}

async function searchContactsByTag(pit, locationId, tag) {
  const all = [];
  let page = 1;
  const pageLimit = 100;
  while (page <= 50) {
    const res = await fetch(`${GHL_BASE}/contacts/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pit}`,
        Version: GHL_VERSION,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        locationId,
        pageLimit,
        page,
        filters: [{ field: 'tags', operator: 'contains', value: tag }],
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`contacts/search page ${page} failed: ${res.status} ${t}`);
    }
    const data = await res.json();
    const contacts = data.contacts ?? [];
    all.push(...contacts);
    if (contacts.length < pageLimit) break;
    page++;
  }
  return all;
}

function getField(contact, fieldKey, schema) {
  const id = schema.get(fieldKey);
  if (!id) return '';
  const f = (contact.customFields || []).find((cf) => cf.id === id);
  if (!f || f.value == null) return '';
  return String(f.value).trim();
}

async function syncWooster() {
  const startedAt = Date.now();
  const { pit, locationId } = await loadPit();
  console.log(`[wooster-sync] using location ${locationId}`);

  const schema = await fetchFieldSchema(pit, locationId);
  console.log(`[wooster-sync] fetched field schema (${schema.size} custom fields)`);

  const contacts = await searchContactsByTag(pit, locationId, ENROLLMENT_TAG);
  console.log(`[wooster-sync] fetched ${contacts.length} contacts tagged "${ENROLLMENT_TAG}"`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Snapshot reset: delete existing Wooster family-graph rows.
    await client.query(`DELETE FROM enrollments WHERE school_id = $1`, [WOOSTER_SCHOOL_ID]);
    await client.query(`DELETE FROM students WHERE school_id = $1`, [WOOSTER_SCHOOL_ID]);
    await client.query(`DELETE FROM parents WHERE school_id = $1`, [WOOSTER_SCHOOL_ID]);
    await client.query(`DELETE FROM families WHERE school_id = $1`, [WOOSTER_SCHOOL_ID]);

    let familiesCreated = 0;
    let parentsCreated = 0;
    let studentsCreated = 0;
    let skipped = 0;

    for (const c of contacts) {
      const firstName = (c.firstName || '').trim();
      const lastName = (c.lastName || '').trim();
      const email = (c.email || '').trim();
      const phone = (c.phone || '').trim();

      if (!email && !phone && !firstName) {
        skipped++;
        continue;
      }

      // Family: one per contact. Display name = parent's name.
      const familyDisplayName = `${firstName} ${lastName}`.trim() || email || '(unnamed family)';
      const fam = await client.query(
        `INSERT INTO families (school_id, display_name, status)
         VALUES ($1, $2, 'active')
         RETURNING id`,
        [WOOSTER_SCHOOL_ID, familyDisplayName],
      );
      const familyId = fam.rows[0].id;
      familiesCreated++;

      // Parent
      await client.query(
        `INSERT INTO parents
           (school_id, family_id, ghl_contact_id, first_name, last_name, email, phone,
            is_primary, role, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, 'parent', 'active')`,
        [
          WOOSTER_SCHOOL_ID, familyId, c.id,
          firstName, lastName, email || null, phone || null,
        ],
      );
      parentsCreated++;

      // Wooster's GHL only stores program + current grade on the
      // CONTACT (i.e. for the primary student). Multi-student families
      // share one record, so slots 2/3/4 have no program field of
      // their own. We capture the contact-level fields once and
      // attach to slot 1 only; later if Wooster splits per-student
      // grade tracking in GHL we can wire each slot.
      const familyProgram   = getField(c, 'select_the_program_this_child_will_attend', schema);
      const familyGradeLvl  = getField(c, 'what_is_your_childs_current_level', schema);

      // Students: scan slots 1..MAX_SLOTS
      for (let slot = 1; slot <= MAX_SLOTS; slot++) {
        const prefix = slot === 1 ? 'student' : `student_${slot}`;
        const fn = getField(c, `${prefix}_first_name`, schema);
        const ln = getField(c, `${prefix}_last_name`, schema);
        if (!fn) continue;

        // Only the primary student inherits the contact-level program
        // / current-level. Other slots show as unassigned in
        // breakdowns until Wooster captures per-student grade tracking.
        const md = { slot, ghl_parent_contact_id: c.id };
        if (slot === 1) {
          if (familyProgram)  md.program     = familyProgram;
          if (familyGradeLvl) md.grade_level = familyGradeLvl;
        }

        const st = await client.query(
          `INSERT INTO students
             (school_id, family_id, first_name, last_name, preferred_name,
              status, metadata)
           VALUES ($1, $2, $3, $4, $5, 'active', $6::jsonb)
           RETURNING id`,
          [
            WOOSTER_SCHOOL_ID, familyId, fn, ln || '',
            null,
            JSON.stringify(md),
          ],
        );
        const studentId = st.rows[0].id;
        studentsCreated++;

        // Enrollment row so attendance / family-hub features work
        await client.query(
          `INSERT INTO enrollments
             (school_id, student_id, status, academic_year)
           VALUES ($1, $2, 'enrolled', $3)`,
          [WOOSTER_SCHOOL_ID, studentId, ACADEMIC_YEAR],
        );
      }
    }

    await client.query('COMMIT');

    const duration = Date.now() - startedAt;
    console.log('');
    console.log(`[wooster-sync] done in ${duration}ms`);
    console.log(`  families:  ${familiesCreated}`);
    console.log(`  parents:   ${parentsCreated}`);
    console.log(`  students:  ${studentsCreated}`);
    console.log(`  skipped:   ${skipped}`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

syncWooster()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => pool.end());
