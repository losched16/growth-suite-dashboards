// Delete every Shrewsbury GHL contact that is actually a STUDENT
// (not a real contact) — these were mis-imported as contacts when
// they should live as student_*_first_name custom fields on the
// parent contact.
//
// Approach:
//   1. Pull the location's custom-field schema; identify the
//      student-slot field IDs (student_first_name, student_last_name,
//      student_2_first_name, ..., student_3_first_name).
//   2. Pull every contact. Build a "known student" set from any
//      contact whose student-slot custom fields are populated.
//      Set keys: "first|last" lowercased.
//   3. For each blank contact (no email, no phone, no tags) whose
//      name matches a known student, delete it from GHL.
//   4. Anything that DOESN'T match a known student (rare — would
//      mean the student isn't on any parent contact's slot) is
//      flagged for human review, not auto-deleted.
//
// Idempotent + logged.
//
// Usage:
//   node scripts/delete-shrewsbury-student-shaped-contacts.mjs            # dry-run
//   node scripts/delete-shrewsbury-student-shaped-contacts.mjs --execute  # really delete

import { readFileSync, writeFileSync } from 'node:fs';
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
  if (!process.env[k]) process.env[k] = t.slice(eq + 1).trim();
}

const EXECUTE = process.argv.includes('--execute');
const SHREWSBURY_SCHOOL_ID = 'bf5e15d7-c0df-4ac6-9b6f-ededee90b02a';
const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';
const LOG_PATH = join(projectRoot, '..', `shrewsbury-student-contacts-${EXECUTE ? 'executed' : 'dryrun'}.json`);

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

function decrypt(b, iv, tag) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(b), d.final()]).toString('utf8');
}

async function loadPit() {
  const r = await pool.query(
    `SELECT ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag FROM schools WHERE id = $1`,
    [SHREWSBURY_SCHOOL_ID],
  );
  return {
    locationId: r.rows[0].ghl_location_id,
    pit: decrypt(r.rows[0].ghl_pit_encrypted, r.rows[0].ghl_pit_iv, r.rows[0].ghl_pit_tag),
  };
}

async function ghl(method, pit, path, body) {
  const r = await fetch(`${GHL_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${pit}`, Version: GHL_VERSION, Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${await r.text()}`);
  const ct = r.headers.get('content-type') || '';
  return ct.includes('application/json') ? r.json() : null;
}

async function fetchAllContacts(pit, locationId) {
  const all = [];
  let page = 1;
  while (page <= 50) {
    const j = await ghl('POST', pit, '/contacts/search', { locationId, pageLimit: 100, page });
    const contacts = j.contacts ?? [];
    all.push(...contacts);
    if (contacts.length < 100) break;
    page++;
  }
  return all;
}

function normName(s) {
  // Tolerate "Lastname, Firstname" by removing commas and collapsing.
  return String(s ?? '')
    .toLowerCase()
    .replace(/,/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}
function nameKey(first, last) {
  return `${normName(first)}|${normName(last)}`;
}
// Also build a "swapped" key for contacts saved as Lastname,Firstname
// — we'll check both orientations.
function swappedKey(first, last) {
  return `${normName(last)}|${normName(first)}`;
}
function isBlank(c) {
  return (!c.email || c.email.trim() === '')
    && (!c.phone || c.phone.trim() === '')
    && (!c.tags  || c.tags.length === 0);
}

async function main() {
  const { pit, locationId } = await loadPit();
  console.log(`[students] mode=${EXECUTE ? 'EXECUTE' : 'DRY-RUN'}`);

  // 1. Discover the student-slot field IDs.
  const cfRes = await ghl('GET', pit, `/locations/${locationId}/customFields`);
  const studentSlotKeys = [
    'student_first_name', 'student_last_name',
    'student_2_first_name', 'student_2_last_name',
    'student_3_first_name', 'student_3_last_name',
  ];
  const slotFieldIds = new Map();
  for (const f of cfRes.customFields ?? []) {
    const k = (f.fieldKey || '').replace(/^contact\./, '');
    if (studentSlotKeys.includes(k)) slotFieldIds.set(k, f.id);
  }
  console.log('[students] student-slot field IDs found:', slotFieldIds.size, '/', studentSlotKeys.length);

  // 2. Fetch all contacts.
  console.log('[students] fetching contacts…');
  const all = await fetchAllContacts(pit, locationId);
  console.log(`[students] ${all.length} contacts on file`);

  // 3. Build known-student set from parent-contact slot fields.
  // We collect all 3 slots per parent contact.
  function readField(contact, fieldId) {
    if (!fieldId) return '';
    const hit = (contact.customFields || []).find((cf) => cf.id === fieldId);
    return hit && hit.value ? String(hit.value).trim() : '';
  }
  const knownStudents = new Set();
  let parentsWithStudents = 0;
  for (const c of all) {
    let added = false;
    for (const slot of [['student_first_name', 'student_last_name'],
                        ['student_2_first_name', 'student_2_last_name'],
                        ['student_3_first_name', 'student_3_last_name']]) {
      const f = readField(c, slotFieldIds.get(slot[0]));
      const l = readField(c, slotFieldIds.get(slot[1]));
      if (f || l) {
        knownStudents.add(nameKey(f, l));
        added = true;
      }
    }
    if (added) parentsWithStudents++;
  }
  console.log(`[students] ${parentsWithStudents} parents carry student data → ${knownStudents.size} distinct student names tracked`);

  // 4. Walk blank contacts. Anything whose name matches a known
  // student (either firstname-lastname OR lastname-firstname for the
  // "Lastname, Firstname" import) is a student-shaped contact and
  // gets deleted.
  const log = {
    started_at: new Date().toISOString(),
    mode: EXECUTE ? 'execute' : 'dry-run',
    contacts_total: all.length,
    parents_with_students: parentsWithStudents,
    known_students_distinct: knownStudents.size,
    matched_deletions: [],
    unmatched_orphans: [],
    failures: [],
  };

  for (const c of all) {
    if (!isBlank(c)) continue;
    const k1 = nameKey(c.firstName, c.lastName);
    const k2 = swappedKey(c.firstName, c.lastName); // tolerate "Smith, John"
    const matchedAs = knownStudents.has(k1) ? k1 : (knownStudents.has(k2) ? k2 : null);
    if (!matchedAs) {
      // Skip — keep for human review
      log.unmatched_orphans.push({
        ghl_contact_id: c.id,
        firstName: c.firstName,
        lastName: c.lastName,
        created: c.dateAdded,
      });
      continue;
    }
    if (!EXECUTE) {
      log.matched_deletions.push({
        would_delete_contact_id: c.id,
        name: `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim(),
        matched_as: matchedAs,
      });
      continue;
    }
    try {
      await ghl('DELETE', pit, `/contacts/${c.id}`);
      log.matched_deletions.push({
        deleted_contact_id: c.id,
        name: `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim(),
        matched_as: matchedAs,
        deleted_at: new Date().toISOString(),
      });
      if (log.matched_deletions.length % 25 === 0) console.log(`  …deleted ${log.matched_deletions.length}`);
    } catch (e) {
      log.failures.push({ contact_id: c.id, error: e.message });
    }
  }

  log.finished_at = new Date().toISOString();
  writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));

  console.log('\n──── Summary ────');
  console.log(`  Contacts scanned:                 ${log.contacts_total}`);
  console.log(`  Parents carrying student data:    ${log.parents_with_students}`);
  console.log(`  Distinct student names tracked:   ${log.known_students_distinct}`);
  console.log(`  ${EXECUTE ? 'Deleted (student-shaped)' : 'Would delete (student-shaped)'}: ${log.matched_deletions.length}`);
  console.log(`  Unmatched blank contacts (kept):  ${log.unmatched_orphans.length}`);
  console.log(`  Failures:                         ${log.failures.length}`);
  console.log(`\n  Full log: ${LOG_PATH}`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => pool.end());
