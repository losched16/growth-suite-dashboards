// Backfill Wooster's native GHL form/survey submissions into
// portal_form_submissions so the Document Tracker reflects them.
//
// Strategy:
//   1. Pull every submission from each GHL form/survey we're mapping
//   2. Resolve contactId → parent → family
//   3. For "- Student N" variants → identify the Nth student in the family
//   4. Insert as portal_form_submissions with legacy_source='wooster_ghl_form_v1'
//      and status='legacy_imported'
//   5. Dedupe: skip if a legacy submission already exists for the
//      (family, form, student) tuple (CSV-imported earlier).
//
// Idempotent — re-run safely. Writes a deterministic key into
// responses._ghl_submission_id so we can spot dupes on subsequent runs.
//
// Usage:
//   node scripts/import-wooster-ghl-form-submissions.mjs            # DRY RUN
//   node scripts/import-wooster-ghl-form-submissions.mjs --apply    # write

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import pg from 'pg';
import axios from 'axios';

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

const APPLY = process.argv.includes('--apply');
const SCHOOL_ID = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
const LEGACY_SOURCE = 'wooster_ghl_form_v1';

// ── Mapping: GHL form name → portal_form_definitions.slug ─────────
// `studentSlot`: for "- Student N" variants, the slot number (2/3/4).
// Slot 1 (or unspecified) targets the first kid in the family.
const FORM_MAPPING = [
  { ghlName: 'Enrollment Agreement',                                          slug: 'enrollment-agreement', studentSlot: 1 },
  { ghlName: 'Enrollment Agreement - Student 2',                              slug: 'enrollment-agreement', studentSlot: 2 },
  { ghlName: 'Enrollment Agreement - Student 3',                              slug: 'enrollment-agreement', studentSlot: 3 },
  { ghlName: 'Enrollment Agreement - Student 4',                              slug: 'enrollment-agreement', studentSlot: 4 },

  { ghlName: 'Emergency Medical Authorization',                               slug: 'emergency-medical',    studentSlot: 1 },
  { ghlName: 'Emergency Medical Authorization - Student 2',                   slug: 'emergency-medical',    studentSlot: 2 },
  { ghlName: 'Emergency Medical Authorization - Student 3',                   slug: 'emergency-medical',    studentSlot: 3 },
  { ghlName: 'Emergency Medical Authorization - Student 4',                   slug: 'emergency-medical',    studentSlot: 4 },

  { ghlName: 'Current Medications & Over-the-Counter Permissions',            slug: 'medications',          studentSlot: 1 },
  { ghlName: 'Current Medications & Over-the-Counter Permissions - Student 2',slug: 'medications',          studentSlot: 2 },
  { ghlName: 'Current Medications & Over-the-Counter Permissions - Student 3',slug: 'medications',          studentSlot: 3 },
  { ghlName: 'Current Medications & Over-the-Counter Permissions - Student 4',slug: 'medications',          studentSlot: 4 },

  { ghlName: 'Past & Ongoing Health Conditions',                              slug: 'health-conditions',    studentSlot: 1 },
  { ghlName: 'Past & Ongoing Health Conditions - Student 2',                  slug: 'health-conditions',    studentSlot: 2 },
  { ghlName: 'Past & Ongoing Health Conditions - Student 3',                  slug: 'health-conditions',    studentSlot: 3 },

  { ghlName: 'Health History & Medical Profile Forms',                        slug: 'health-history',       studentSlot: 1 },
  { ghlName: 'Health History & Medical Profile Forms - Student 2',            slug: 'health-history',       studentSlot: 2 },
  { ghlName: 'Health History & Medical Profile Forms - Student 3',            slug: 'health-history',       studentSlot: 3 },
  { ghlName: 'Health History & Medical Profile Forms - Student 4',            slug: 'health-history',       studentSlot: 4 },

  { ghlName: 'Injury, Hospitalization, and Surgery History',                  slug: 'injury-history',       studentSlot: 1 },
  { ghlName: 'Injury, Hospitalization, and Surgery History - Student 2',      slug: 'injury-history',       studentSlot: 2 },
  { ghlName: 'Injury, Hospitalization, and Surgery History - Student 3',      slug: 'injury-history',       studentSlot: 3 },
  { ghlName: 'Injury, Hospitalization, and Surgery History - Student 4',      slug: 'injury-history',       studentSlot: 4 },

  { ghlName: 'Media Permission',          slug: 'media-permission' },
  { ghlName: 'ODE Connectivity Questions', slug: 'ode-connectivity' },
];

// AES-256-GCM decrypt (mirrors lib/crypto.ts so this script is standalone)
function decrypt(encrypted, iv, tag) {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error('ENCRYPTION_KEY env var missing');
  let key = Buffer.from(raw, 'base64');
  if (key.length !== 32) key = Buffer.from(raw, 'hex');
  if (key.length !== 32) throw new Error(`ENCRYPTION_KEY decoded to ${key.length} bytes; need 32`);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function makeClient(school) {
  const pit = decrypt(school.ghl_pit_encrypted, school.ghl_pit_iv, school.ghl_pit_tag);
  return axios.create({
    baseURL: 'https://services.leadconnectorhq.com',
    headers: {
      Authorization: `Bearer ${pit}`,
      Version: '2021-07-28',
      Accept: 'application/json',
    },
    timeout: 30_000,
  });
}

async function listAllForms(client, locationId) {
  const out = [];
  let skip = 0;
  while (true) {
    const { data } = await client.get('/forms/', { params: { locationId, skip, limit: 50 } });
    const batch = data?.forms ?? [];
    if (batch.length === 0) break;
    out.push(...batch);
    if (batch.length < 50) break;
    skip += batch.length;
    if (skip > 2000) break;
  }
  return out;
}

async function listFormSubmissions(client, locationId, formId) {
  // GHL's /forms/submissions caps at 50 with no skip/page support — we
  // get what we get. For Wooster's volumes (≤25 per form) this is fine.
  const { data } = await client.get('/forms/submissions', {
    params: { locationId, formId, limit: 50 },
  });
  return data?.submissions ?? [];
}

async function main() {
  console.log(`Mode: ${APPLY ? '\x1b[31mAPPLY\x1b[0m (writes)' : '\x1b[36mDRY RUN\x1b[0m'}\n`);

  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const { rows: schoolRows } = await pool.query(
    `SELECT id, name, ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag
       FROM schools WHERE id = $1`,
    [SCHOOL_ID],
  );
  const school = schoolRows[0];
  if (!school) { console.error('School not found'); process.exit(1); }
  const client = makeClient(school);

  // Index portal forms by slug
  const { rows: pfdRows } = await pool.query(
    `SELECT id, slug, per_student FROM portal_form_definitions
      WHERE school_id = $1 AND COALESCE(audience,'parents')='parents'`,
    [school.id],
  );
  const pfdBySlug = new Map(pfdRows.map((r) => [r.slug, r]));

  // List GHL forms once + index by name → id
  const ghlForms = await listAllForms(client, school.ghl_location_id);
  const ghlByName = new Map(ghlForms.map((f) => [f.name, f]));

  // Pre-load family / parent / student data for fast lookup. Wooster has
  // ~300 students — fits in memory easily.
  const { rows: parents } = await pool.query(
    `SELECT ghl_contact_id, id AS parent_id, family_id
       FROM parents WHERE school_id = $1 AND ghl_contact_id IS NOT NULL`,
    [school.id],
  );
  const familyByContact = new Map(parents.map((p) => [p.ghl_contact_id, { parent_id: p.parent_id, family_id: p.family_id }]));
  console.log(`Indexed ${familyByContact.size} parents with ghl_contact_id\n`);

  const { rows: students } = await pool.query(
    `SELECT id, family_id, first_name FROM students WHERE school_id = $1 AND status = 'active' ORDER BY family_id, first_name`,
    [school.id],
  );
  const studentsByFamily = new Map();
  for (const s of students) {
    if (!studentsByFamily.has(s.family_id)) studentsByFamily.set(s.family_id, []);
    studentsByFamily.get(s.family_id).push(s);
  }

  // Stats
  let totalSeen = 0, totalSkippedUnknownContact = 0, totalSkippedExisting = 0, totalImported = 0, totalSkippedNoStudent = 0;
  const perFormSummary = [];

  for (const map of FORM_MAPPING) {
    const ghlForm = ghlByName.get(map.ghlName);
    if (!ghlForm) {
      console.log(`  ⚠️  GHL form not found: "${map.ghlName}" — skipped`);
      continue;
    }
    const pfd = pfdBySlug.get(map.slug);
    if (!pfd) {
      console.log(`  ⚠️  Portal form slug not found: "${map.slug}" — skipped`);
      continue;
    }
    const subs = await listFormSubmissions(client, school.ghl_location_id, ghlForm.id);
    let imported = 0, skipped = 0;

    for (const sub of subs) {
      totalSeen++;
      const contactId = sub.contactId || sub.contact_id;
      if (!contactId) { totalSkippedUnknownContact++; skipped++; continue; }
      const fam = familyByContact.get(contactId);
      if (!fam) { totalSkippedUnknownContact++; skipped++; continue; }

      // Resolve target student for per-student forms.
      let studentId = null;
      if (pfd.per_student) {
        const kids = studentsByFamily.get(fam.family_id) ?? [];
        const slot = map.studentSlot ?? 1;
        if (kids.length < slot) {
          // Family doesn't have a student N — skip rather than misattribute.
          totalSkippedNoStudent++;
          skipped++;
          continue;
        }
        studentId = kids[slot - 1].id;
      }

      // Dedupe against any existing legacy submission for this
      // (family, form, student) tuple. CSV imports already cover most
      // of these; the GHL run is filling gaps.
      const dupeQ = await pool.query(
        `SELECT 1 FROM portal_form_submissions
          WHERE school_id = $1 AND form_definition_id = $2 AND family_id = $3
            AND COALESCE(student_id::text,'_') = COALESCE($4::text,'_')
            AND legacy_source IS NOT NULL
          LIMIT 1`,
        [school.id, pfd.id, fam.family_id, studentId],
      );
      if (dupeQ.rows.length > 0) { totalSkippedExisting++; skipped++; continue; }

      // Build the responses jsonb. Keep the GHL field bag plus a stamp
      // so future re-runs / forensics can trace it.
      const responses = {
        ...(sub.others ?? sub.formData ?? {}),
        _ghl_submission_id: sub.id,
        _ghl_form_name: map.ghlName,
        _imported_at: new Date().toISOString(),
      };
      const submittedAt = sub.createdAt || sub.submissionAt || sub.created_at || new Date().toISOString();

      if (APPLY) {
        await pool.query(
          `INSERT INTO portal_form_submissions
             (school_id, form_definition_id, family_id, student_id, parent_id,
              responses, status, submitted_at, legacy_source)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'legacy_imported', $7::timestamptz, $8)`,
          [school.id, pfd.id, fam.family_id, studentId, fam.parent_id, JSON.stringify(responses), submittedAt, LEGACY_SOURCE],
        );
      }
      imported++;
      totalImported++;
    }

    perFormSummary.push({ name: map.ghlName, slug: map.slug, found: subs.length, imported, skipped });
  }

  console.log('\n=== Per-form summary ===');
  for (const r of perFormSummary) {
    console.log(`  ${r.imported.toString().padStart(3)} new · ${r.skipped.toString().padStart(3)} skipped · ${r.found.toString().padStart(3)} total · ${r.slug} ← ${r.name}`);
  }
  console.log('\n=== Overall ===');
  console.log(`  Seen:                      ${totalSeen}`);
  console.log(`  Skipped (no matching contact in DB): ${totalSkippedUnknownContact}`);
  console.log(`  Skipped (no student N in family):     ${totalSkippedNoStudent}`);
  console.log(`  Skipped (dupe of existing legacy):   ${totalSkippedExisting}`);
  console.log(`  ${APPLY ? 'Imported' : 'Would import'}: ${totalImported}`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
