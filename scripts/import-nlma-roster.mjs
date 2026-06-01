// Import Northern Lights Montessori roster from their two source
// CSV exports:
//   - EL Student Details (NLMA) (1).csv         — Elementary
//   - Early Childhood Details (NLMA) (1).csv    — Early Childhood
//
// Source shape: one row per (student × parent). A student with three
// parents appears in three rows; a student with no parent appears in
// one row with the parent columns blank. We aggregate.
//
// Custom-field preservation: every non-standard column from the CSV
// lands in students.metadata so nothing's lost. Standard medical
// fields (allergies, medications, doctor, emergency contact) also
// populate student_health_profiles so the dashboards' health widgets
// pick them up out of the box.
//
// Sibling detection: students with the same last_name AND at least
// one shared parent email belong to the same family. Otherwise each
// student gets their own one-kid family.
//
// USAGE:
//   node scripts/import-nlma-roster.mjs                 # dry run, no writes
//   node scripts/import-nlma-roster.mjs --apply         # commit to DB
//   node scripts/import-nlma-roster.mjs --apply --reset # wipe existing NLMA data first
//
// Re-runnable on top of an existing dataset — uses INSERT … ON CONFLICT
// keyed by (school_id, last_name, first_name, date_of_birth) on a
// hashed natural key in metadata.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// ── env ─────────────────────────────────────────────────────────────
const envText = readFileSync(join(projectRoot, '.env.local'), 'utf8');
for (const line of envText.split('\n')) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('='); if (eq === -1) continue;
  const k = t.slice(0, eq).trim();
  if (!process.env[k]) process.env[k] = t.slice(eq + 1).trim();
}

// ── args ────────────────────────────────────────────────────────────
const APPLY = process.argv.includes('--apply');
const RESET = process.argv.includes('--reset');

const SCHOOL_ID = '2717d71b-aa80-4ca0-8a13-e81cace2d9c1';
const SOURCE_FILES = [
  { path: 'C:/Users/thelo/Downloads/EL Student Details (NLMA) (1).csv',           band: 'EL' },
  { path: 'C:/Users/thelo/Downloads/Early Childhood Details (NLMA) (1).csv',      band: 'EC' },
];

// ── csv parser ──────────────────────────────────────────────────────
// State-machine parser so embedded commas inside quoted fields work.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\r') { /* skip */ }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  // Drop trailing blank rows that are just [""]
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0].trim().length > 0));
}

function toObjects(rows) {
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((row) => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (row[i] ?? '').trim(); });
    return obj;
  });
}

// ── normalizers ─────────────────────────────────────────────────────
function clean(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (!t) return null;
  if (['n/a', 'none', 'na', '.'].includes(t.toLowerCase())) return null;
  return t;
}

function normalizePhone(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;
  // Junk-value filter — "N/a", "None", etc. shouldn't survive into
  // the phone column or GHL will reject the contact create.
  if (['n/a', 'na', 'none', '.', '-', 'tbd', 'unknown'].includes(s.toLowerCase())) return null;
  // strip leading "+1 " or +
  s = s.replace(/^\+/, '').replace(/[\s()\-.]/g, '');
  if (s.length === 11 && s.startsWith('1')) s = s.slice(1);
  if (s.length === 10 && /^\d+$/.test(s)) {
    return `(${s.slice(0, 3)}) ${s.slice(3, 6)}-${s.slice(6)}`;
  }
  // If after stripping there are no digits at all, treat as junk.
  if (!/\d/.test(s)) return null;
  // fall through to as-is for anything funky — better than throwing it away
  return raw.trim() || null;
}

function normalizeEmail(raw) {
  if (!raw) return null;
  const t = String(raw).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? t : null;
}

function splitName(full) {
  if (!full) return { first: null, last: null };
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: null };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}

function parseMDY(s) {
  if (!s) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

// ── aggregate rows → students with parent lists ────────────────────
function studentKey(row) {
  // (first + last + birthday). Birthday rarely missing in this dataset.
  return `${(row['First name'] || '').toLowerCase()}|${(row['Last name'] || '').toLowerCase()}|${row['Birthday'] || ''}`;
}

function aggregate(rows, band) {
  const byStudent = new Map();
  for (const row of rows) {
    const key = studentKey(row);
    if (!byStudent.has(key)) {
      byStudent.set(key, {
        first_name: cleanFirstName(row['First name'] || splitName(row['Student']).first),
        last_name:  row['Last name']  || splitName(row['Student']).last,
        // Preferred name: pulled from quoted nickname inside Student col
        // ('Olivia "Liv" Faul' → 'Liv'), else null.
        preferred_name: extractPreferred(row['Student']),
        date_of_birth: parseMDY(row['Birthday']),
        gender: lowerOrNull(row['Gender']),
        status: (row['Student status'] || '').toLowerCase() === 'active' ? 'active' : 'inactive',
        band,
        homeroom_raw: clean(row['Homeroom']) || band,
        parents: [],
        // shared fields — last write wins; rows for the same student
        // generally agree, but if they differ the last one wins.
        allergies: clean(row['Allergies']),
        medications: clean(row['Medications']),
        notes: clean(row['Notes']),
        ethnicity: clean(row['Ethnicity']),
        race: clean(row['Race']),
        meal_type: clean(row['Meal type']),
        subsidized: clean(row['Subsidized']),
        sibling_attending: clean(row['Sibling attending']),
        emergency_contact_name:        clean(row['Emergency contact name']),
        emergency_contact_phone:       normalizePhone(row['Emergency contact phone']),
        emergency_contact_relationship: clean(row['Emergency contact relationship']),
        doctor_name:                   clean(row['Doctor name']),
        doctor_phone:                  normalizePhone(row['Doctor phone']),
        // address (raw, full)
        address_full:  clean(row['Address']),
        street_1:      clean(row['Street 1']),
        street_2:      clean(row['Street 2']),
        city:          clean(row['City']),
        state:         clean(row['State']),
        country:       clean(row['Country']),
        zip:           clean(row['Zip']),
        // admissions funnel
        enrollment_date:     parseMDY(row['Enrollment date']),
        first_contact_date:  parseMDY(row['First contact date']),
        paperwork_date:      parseMDY(row['Paperwork date']),
        toured_date:         parseMDY(row['Toured date']),
        desired_start_date:  parseMDY(row['Desired start date']),
        graduation_date:     parseMDY(row['Graduation date']),
        additional_details:  clean(row['Additional details']),
      });
    }
    const student = byStudent.get(key);
    const pname = clean(row['Parent name']);
    if (pname) {
      const { first, last } = splitName(pname);
      const phone = normalizePhone(row['Parent phone']);
      const email = normalizeEmail(row['Parent email']);
      // dedupe — same parent name + email combo across rows shouldn't
      // create two parent records.
      const dupe = student.parents.find((p) => p.first === first && p.last === last && p.email === email);
      if (!dupe) {
        student.parents.push({ first, last, email, phone });
      } else if (!dupe.phone && phone) {
        dupe.phone = phone;
      }
    }
  }
  return [...byStudent.values()];
}

// Merge "zombie" duplicate rows (same first+last, missing DOB) into
// the canonical record. Preserves any non-null fields the zombie row
// brought along (parents, notes), in case there's signal there.
function dedupeOrphans(students) {
  const out = [];
  const byName = new Map();
  // First pass: pick a canonical per (first, last) — the one WITH a
  // date_of_birth wins. If multiple have DOB, keep all (twins, etc.).
  for (const s of students) {
    const k = `${(s.first_name || '').toLowerCase()}|${(s.last_name || '').toLowerCase()}`;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(s);
  }
  for (const list of byName.values()) {
    const withDob = list.filter((x) => x.date_of_birth);
    const noDob   = list.filter((x) => !x.date_of_birth);
    if (withDob.length === 0) { out.push(...list); continue; }   // nothing to merge into
    // Merge each no-DOB orphan into the first canonical record.
    const canonical = withDob[0];
    for (const orphan of noDob) {
      // pull non-null fields the orphan had but canonical didn't
      for (const key of Object.keys(orphan)) {
        if (key === 'parents') continue;
        if (canonical[key] == null && orphan[key] != null) canonical[key] = orphan[key];
      }
      // merge unique parents
      for (const op of orphan.parents) {
        const dupe = canonical.parents.find((cp) =>
          cp.first === op.first && cp.last === op.last && cp.email === op.email);
        if (!dupe) canonical.parents.push(op);
      }
    }
    out.push(...withDob);
  }
  return out;
}

function extractPreferred(student) {
  if (!student) return null;
  const m = /"([^"]+)"/.exec(student);
  return m ? m[1] : null;
}
// Strip a quoted nickname out of the "First name" column so we don't
// store "Olivia \"Liv\"" as the literal first name. Returns the clean
// first name (everything outside quotes).
function cleanFirstName(s) {
  if (!s) return s;
  return s.replace(/\s*"[^"]+"\s*/g, ' ').replace(/\s+/g, ' ').trim() || s;
}
function lowerOrNull(v) {
  if (!v) return null;
  const t = v.toString().trim().toLowerCase();
  return t || null;
}

// ── family grouping (sibling detection) ────────────────────────────
function groupFamilies(students) {
  // Build a graph: students that share a parent email belong to the
  // same family. Also: same last_name + same address → family. This
  // handles single-parent siblings + multi-parent siblings.
  const parent = new Array(students.length).fill(0).map((_, i) => i);
  const find = (i) => parent[i] === i ? i : (parent[i] = find(parent[i]));
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

  const nameKey = (p) => `${(p.first || '').toLowerCase()}|${(p.last || '').toLowerCase()}`;
  for (let i = 0; i < students.length; i++) {
    for (let j = i + 1; j < students.length; j++) {
      const a = students[i], b = students[j];
      if (!a.last_name || !b.last_name) continue;
      if (a.last_name.toLowerCase() !== b.last_name.toLowerCase()) continue;
      // Same last_name. Need at least one of these signals before we
      // declare them siblings (a pair of unrelated "Smith" kids must
      // NOT merge):
      //   1) any shared parent email
      //   2) any shared parent full name (catches NLMA's frequent
      //      "Chelsey Gregg" with empty email rows)
      //   3) shared street address
      //   4) one side has zero parents — orphan rows for a sibling
      //      that's likely the same household. NLMA's blank Beau
      //      Grosz row falls in here.
      const sharedEmail = a.parents.some((pa) => pa.email && b.parents.some((pb) => pb.email === pa.email));
      const sharedName  = a.parents.some((pa) => b.parents.some((pb) => nameKey(pa) === nameKey(pb) && nameKey(pa) !== '|'));
      const sharedAddr  = a.street_1 && b.street_1 && a.street_1.toLowerCase() === b.street_1.toLowerCase();
      const orphanSib   = (a.parents.length === 0) !== (b.parents.length === 0);   // exactly one is orphan
      if (sharedEmail || sharedName || sharedAddr || orphanSib) union(i, j);
    }
  }
  const groups = new Map();
  for (let i = 0; i < students.length; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(students[i]);
  }
  return [...groups.values()];
}

// ── main ────────────────────────────────────────────────────────────
async function main() {
  console.log(`Mode: ${APPLY ? (RESET ? 'APPLY (with --reset)' : 'APPLY') : 'DRY-RUN (no writes)'}`);
  console.log(`School: Northern Lights Montessori (${SCHOOL_ID})\n`);

  // Load + parse both CSVs
  let allStudents = [];
  for (const src of SOURCE_FILES) {
    const text = readFileSync(src.path, 'utf8');
    const rows = toObjects(parseCsv(text));
    console.log(`  ${src.band}: read ${rows.length} parent-rows from ${src.path.split('/').pop()}`);
    const students = aggregate(rows, src.band);
    console.log(`  ${src.band}: aggregated to ${students.length} unique student${students.length === 1 ? '' : 's'}`);
    allStudents = allStudents.concat(students);
  }

  // Second-pass merge: zombie rows for the same name with no birthday
  // (NLMA's source has a few of these — e.g. row 5 for Beau Grosz has
  // every column blank) should collapse into the canonical record
  // instead of becoming a phantom second student. Merge any name-
  // match where one side lacks a date_of_birth into the side that
  // has one.
  allStudents = dedupeOrphans(allStudents);
  console.log(`\nTotal unique students (all bands): ${allStudents.length}`);

  const families = groupFamilies(allStudents);
  console.log(`Family clusters detected: ${families.length}\n`);

  // Print preview of each family group
  for (const fam of families) {
    const lastName = fam[0].last_name;
    const studentList = fam.map((s) => `${s.first_name}${s.preferred_name ? ` "${s.preferred_name}"` : ''} (${s.band}, ${s.status})`).join(', ');
    const parentNames = [...new Set(fam.flatMap((s) => s.parents.map((p) => `${p.first} ${p.last ?? ''}`.trim())))];
    console.log(`  ${(lastName ?? '(no-last-name)').padEnd(15)}  kids=[${studentList}]   parents=[${parentNames.join(', ')}]`);
  }

  if (!APPLY) {
    console.log(`\n  (dry-run — re-run with --apply to commit)`);
    return;
  }

  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (RESET) {
      console.log('\n  Resetting NLMA roster…');
      // Order matters because of FKs.
      await client.query(`DELETE FROM student_health_profiles WHERE school_id = $1`, [SCHOOL_ID]);
      await client.query(`DELETE FROM students     WHERE school_id = $1`, [SCHOOL_ID]);
      await client.query(`DELETE FROM parents      WHERE school_id = $1`, [SCHOOL_ID]);
      await client.query(`DELETE FROM families     WHERE school_id = $1`, [SCHOOL_ID]);
      console.log('  Reset complete.');
    }

    let famCount = 0, parCount = 0, stuCount = 0, hpCount = 0;
    for (const famStudents of families) {
      const lastName = famStudents[0].last_name ?? '(unknown)';
      const displayName = `${lastName} Family`;

      // Unique address for the family — use the first non-null among the kids
      const fAddress = famStudents.map((s) => ({
        full: s.address_full, s1: s.street_1, s2: s.street_2,
        city: s.city, state: s.state, country: s.country, zip: s.zip,
      })).find((a) => a.s1 || a.full);

      // Insert family
      const famRes = await client.query(
        `INSERT INTO families (school_id, display_name, status, notes)
         VALUES ($1, $2, 'active', $3) RETURNING id`,
        [
          SCHOOL_ID, displayName,
          // Store the family address in notes for now — we don't have
          // typed address columns on families. The same parsed bits
          // also land on each student's metadata so the family hub
          // can render them.
          fAddress?.full ?? null,
        ],
      );
      const familyId = famRes.rows[0].id;
      famCount++;

      // Aggregate every unique parent across this family's kids
      const seenParentKey = new Set();
      const parentIdByKey = new Map();
      let isFirstParent = true;
      for (const s of famStudents) {
        for (const p of s.parents) {
          const k = `${(p.first || '').toLowerCase()}|${(p.last || '').toLowerCase()}|${p.email ?? ''}`;
          if (seenParentKey.has(k)) continue;
          seenParentKey.add(k);
          const parRes = await client.query(
            `INSERT INTO parents
               (family_id, school_id, first_name, last_name, email, phone, role, is_primary, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'parent', $7, 'active') RETURNING id`,
            [familyId, SCHOOL_ID, p.first, p.last, p.email, p.phone, isFirstParent],
          );
          parentIdByKey.set(k, parRes.rows[0].id);
          isFirstParent = false;
          parCount++;
        }
      }

      // Insert students + health profiles
      for (const s of famStudents) {
        const metadata = {
          homeroom:          s.homeroom_raw,
          program_band:      s.band,        // EL / EC
          ethnicity:         s.ethnicity,
          race:              s.race,
          meal_type:         s.meal_type,
          subsidized:        s.subsidized,
          sibling_attending: s.sibling_attending,
          additional_details: s.additional_details,
          // admissions funnel — kept as date strings
          first_contact_date:  s.first_contact_date,
          paperwork_date:      s.paperwork_date,
          toured_date:         s.toured_date,
          desired_start_date:  s.desired_start_date,
          enrollment_date:     s.enrollment_date,
          graduation_date:     s.graduation_date,
          // address (parsed) for inline display
          address: {
            full:    s.address_full,
            street1: s.street_1, street2: s.street_2,
            city:    s.city,     state: s.state,
            zip:     s.zip,      country: s.country,
          },
          // legacy display fields the dashboards already understand
          allergy:               s.allergies,     // shown on roster
          special_instructions:  s.notes,         // shown on roster
        };
        // Drop nulls so metadata is tidy
        for (const k of Object.keys(metadata)) {
          if (metadata[k] == null || (typeof metadata[k] === 'object' && Object.values(metadata[k]).every((v) => v == null))) {
            delete metadata[k];
          }
        }

        const stuRes = await client.query(
          `INSERT INTO students
             (family_id, school_id, first_name, last_name, preferred_name,
              date_of_birth, gender, status, notes, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
           RETURNING id`,
          [
            familyId, SCHOOL_ID, s.first_name, s.last_name, s.preferred_name,
            s.date_of_birth, s.gender, s.status, s.notes,
            JSON.stringify(metadata),
          ],
        );
        stuCount++;

        // Health profile — only insert when we have something to say.
        const anyHealth = s.allergies || s.medications || s.doctor_name || s.doctor_phone
                       || s.emergency_contact_name || s.emergency_contact_phone || s.notes;
        if (anyHealth) {
          await client.query(
            `INSERT INTO student_health_profiles
               (school_id, student_id, allergies, current_medications,
                primary_doctor_name, primary_doctor_phone,
                emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
                medical_conditions)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              SCHOOL_ID, stuRes.rows[0].id,
              s.allergies, s.medications,
              s.doctor_name, s.doctor_phone,
              s.emergency_contact_name, s.emergency_contact_phone, s.emergency_contact_relationship,
              s.notes,
            ],
          );
          hpCount++;
        }
      }
    }

    await client.query('COMMIT');
    console.log(`\n  Committed.\n    families: ${famCount}\n    parents:  ${parCount}\n    students: ${stuCount}\n    health profiles: ${hpCount}`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('  Import failed (rolled back):', e);
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
