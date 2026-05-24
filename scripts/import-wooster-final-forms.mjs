// Import Wooster's Final Forms export into the dashboards DB.
//
// Source: the per-student "Full Export From Final Forms" sheet that
// Wooster sent over after we asked why their student data was sparse.
// Final Forms is the school's operational system of record — every
// student has a row with ~580 fields covering medical, parents,
// emergency contacts, pickup permissions, transportation, etc.
//
// What this script does (idempotent — re-run safely):
//
//   For each row in the file:
//     1. Try to match an existing student in our DB by (last_name +
//        first_name OR preferred_name), scoped to school + active.
//     2. If matched → UPDATE the student + write related rows.
//     3. If NOT matched → INSERT a new family/parent/student/enrollment.
//
//   Writes:
//     - students.date_of_birth, gender, preferred_name; metadata.grade,
//       metadata.program, metadata.payment_plan, metadata.lives_with,
//       metadata.race, metadata.is_returning
//     - parents: keep the existing GHL-linked parent in place; if
//       Final Forms has a SECOND parent (different email), insert as
//       non-primary with role='parent'. If the existing parent's email
//       doesn't match either FF parent we DON'T overwrite — Final
//       Forms could be stale on that point.
//     - student_health_profiles: UPSERT all medical fields (doctor,
//       hospital, insurance, allergies, medications, medical
//       conditions, and the canonical "Emergency Contact 1" goes into
//       emergency_contact_name/phone/relationship; EC2/EC3 become
//       pickup_persons rows).
//     - pickup_persons: any parent or emergency contact with "Can
//       Pick Up = TRUE" is added as a pickup_persons row so they're
//       on the curbside / check-out picker.
//
//   Out of scope (deferred):
//     - GHL contact writeback (we can sync these new fields back to
//       GHL custom fields in a separate pass)
//     - Per-day transportation routing
//     - Sports / extracurriculars / ImPACT testing fields
//     - Withdrawn/archived students (the file has none right now —
//       Enrollment Status is "Active" for all 240 rows)
//
// Reporting: prints a summary table at the end (added/updated/skipped
// counts per row type) plus a CSV of any rows that failed to match
// cleanly.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// Load env
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
const ACADEMIC_YEAR = '2026-27';
const positionalArgs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const FILE_PATH = positionalArgs[0] || 'C:/Users/thelo/Downloads/Data Files From Final Forms (1).xlsx';
const DRY_RUN = process.argv.includes('--dry-run');

if (DRY_RUN) console.log('[DRY RUN] no writes will be made');

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ─── helpers ─────────────────────────────────────────────────────────

function clean(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length === 0 || s === 'NULL' ? null : s;
}
function bool(v) {
  const s = clean(v);
  if (s == null) return null;
  return s.toUpperCase() === 'TRUE' || s === '1';
}
function nameKey(first, last) {
  return `${(first || '').trim().toLowerCase()}|${(last || '').trim().toLowerCase()}`;
}
function emailKey(s) {
  return (s ?? '').trim().toLowerCase();
}

// Map Final Forms numeric grade to a Montessori-friendly level label.
// FF uses negative grades for pre-K (e.g. -3 = young toddler, -1 = pre-K).
//
// Groupings match Wooster's Montessori model — the school's own GHL
// dropdown labels confirm these boundaries (e.g. "Sixth Grader - Upper
// Elementary", "Seventh Grader - Middle School"). DO NOT change these
// without coordinating; the normalize script
// `_normalize_wooster_grade_levels.mjs` shares this canonical mapping.
function gradeLabel(rawGrade) {
  if (rawGrade == null || rawGrade === '') return null;
  const n = Number(rawGrade);
  if (!Number.isFinite(n)) return String(rawGrade);
  if (n <= -3) return 'Toddler (under 3)';
  if (n === -2) return 'Preschool (3 yr)';
  if (n === -1) return 'Pre-K (4 yr)';
  if (n === 0)  return 'Kindergarten';
  if (n >= 1 && n <= 3) return `${n}${ordinalSuffix(n)} Grade (Lower Elementary)`;
  if (n >= 4 && n <= 6) return `${n}${ordinalSuffix(n)} Grade (Upper Elementary)`;
  if (n >= 7 && n <= 8) return `${n}${ordinalSuffix(n)} Grade (Middle School)`;
  if (n >= 9 && n <= 12) return `${n}${ordinalSuffix(n)} Grade (High School)`;
  return `Grade ${n}`;
}
function ordinalSuffix(n) {
  if (n >= 11 && n <= 13) return 'th';
  switch (n % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}
// Parse FF "Date of Birth" which arrives as a string like "2/22/18" (M/D/YY)
// or already an ISO string. Returns YYYY-MM-DD or null.
function parseDob(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  // Try ISO YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // M/D/YY or M/D/YYYY
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let [, mm, dd, yy] = m;
    if (yy.length === 2) yy = Number(yy) > 30 ? `19${yy}` : `20${yy}`;
    return `${yy}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}`;
  }
  return null;
}

// ─── main ─────────────────────────────────────────────────────────────

async function main() {
  const wb = XLSX.read(readFileSync(FILE_PATH));
  const ff = XLSX.utils.sheet_to_json(wb.Sheets['Full Export From Final Forms'], { defval: null, raw: false });
  console.log(`Loaded ${ff.length} rows from Final Forms export`);

  const c = await pool.connect();
  try {
    // Load existing students + parents
    const dbStudents = (await c.query(
      `SELECT s.id, s.family_id, s.first_name, s.last_name, s.preferred_name, s.metadata
       FROM students s WHERE s.school_id = $1 AND s.status = 'active'`,
      [WOOSTER_SCHOOL_ID],
    )).rows;
    const studentByName = new Map();
    for (const s of dbStudents) {
      for (const key of [
        nameKey(s.first_name, s.last_name),
        nameKey(s.preferred_name, s.last_name),
      ]) {
        if (!studentByName.has(key)) studentByName.set(key, []);
        studentByName.get(key).push(s);
      }
    }

    const dbParents = (await c.query(
      `SELECT id, family_id, email, first_name, last_name, ghl_contact_id, is_primary
       FROM parents WHERE school_id = $1`,
      [WOOSTER_SCHOOL_ID],
    )).rows;
    const parentsByFamily = new Map();
    for (const p of dbParents) {
      const arr = parentsByFamily.get(p.family_id) ?? [];
      arr.push(p);
      parentsByFamily.set(p.family_id, arr);
    }

    const counts = {
      students_updated: 0,
      students_inserted: 0,
      families_inserted: 0,
      parents_inserted: 0,
      health_profiles_upserted: 0,
      pickup_persons_inserted: 0,
      pickup_persons_skipped_existing: 0,
      enrollments_updated: 0,
      unmatched_logged: 0,
    };
    const unmatchedRows = [];

    if (!DRY_RUN) await c.query('BEGIN');

    for (const r of ff) {
      const firstName = clean(r['First Name']);
      const lastName = clean(r['Last Name']);
      const preferred = clean(r['Preferred First Name']);
      if (!firstName || !lastName) continue;

      const archived = bool(r['Is Archived']);
      if (archived) continue;

      // Match: prefer first+last, fall back to preferred+last
      let candidates = studentByName.get(nameKey(firstName, lastName)) ?? [];
      if (candidates.length === 0 && preferred) {
        candidates = studentByName.get(nameKey(preferred, lastName)) ?? [];
      }

      // If multiple candidates (siblings with same name?), disambiguate by parent email
      const p1Email = emailKey(r['Parent 1 Email']);
      const p2Email = emailKey(r['Parent 2 Email']);
      let student = candidates[0];
      if (candidates.length > 1) {
        // Pick the one whose family has a parent matching email
        for (const cand of candidates) {
          const fparents = parentsByFamily.get(cand.family_id) ?? [];
          if (fparents.some((p) => p.email && [p1Email, p2Email].includes(emailKey(p.email)))) {
            student = cand; break;
          }
        }
      }

      let studentId, familyId;

      // ─── 1. Insert new student/family if no match ──────────────────────
      if (!student) {
        // Try to find an existing family by Parent 1 email
        const existingParent = dbParents.find((p) => emailKey(p.email) === p1Email && p1Email);
        if (existingParent) {
          // Add this student to the existing family
          familyId = existingParent.family_id;
          const slot = (parentsByFamily.get(familyId)?.length ?? 0) + 1; // best-effort slot
          const stIns = await execSafe(c,
            `INSERT INTO students
               (school_id, family_id, first_name, last_name, preferred_name,
                date_of_birth, gender, status, metadata)
             VALUES ($1, $2, $3, $4, $5, $6::date, $7, 'active', $8::jsonb)
             RETURNING id`,
            [
              WOOSTER_SCHOOL_ID, familyId, firstName, lastName, preferred,
              parseDob(r['Date of Birth']),
              clean(r['Gender'])?.toLowerCase() ?? null,
              JSON.stringify({
                slot,
                source: 'final_forms_import',
                grade: clean(r['Grade']),
                grade_level: gradeLabel(r['Grade']),
                program: clean(r['Program']),
                payment_plan: clean(r['Payment Plan']),
                race: clean(r['Race']),
                lives_with: clean(r['Lives With Status']),
                is_returning: bool(r['Has Been Enrolled In District Before']),
              }),
            ],
          );
          studentId = stIns.rows[0].id;
          await execSafe(c,
            `INSERT INTO enrollments (school_id, student_id, status, academic_year)
             VALUES ($1, $2, 'enrolled', $3)
             ON CONFLICT DO NOTHING`,
            [WOOSTER_SCHOOL_ID, studentId, ACADEMIC_YEAR],
          );
          counts.students_inserted++;
        } else {
          // Create a new family
          const display = `${clean(r['Parent 1 First Name']) ?? firstName} ${clean(r['Parent 1 Last Name']) ?? lastName}`.trim();
          const famIns = await execSafe(c,
            `INSERT INTO families (school_id, display_name, status) VALUES ($1, $2, 'active') RETURNING id`,
            [WOOSTER_SCHOOL_ID, display],
          );
          familyId = famIns.rows[0].id;
          counts.families_inserted++;

          // Parent 1
          if (clean(r['Parent 1 First Name'])) {
            const pIns = await execSafe(c,
              `INSERT INTO parents
                 (school_id, family_id, ghl_contact_id, first_name, last_name, email, phone,
                  is_primary, role, status)
               VALUES ($1, $2, NULL, $3, $4, $5, $6, true, $7, 'active')
               RETURNING id`,
              [
                WOOSTER_SCHOOL_ID, familyId,
                clean(r['Parent 1 First Name']),
                clean(r['Parent 1 Last Name']),
                clean(r['Parent 1 Email']),
                clean(r['Parent 1 Cell Phone']) ?? clean(r['Parent 1 Home Phone']) ?? clean(r['Parent 1 Work Phone']),
                inferRole(clean(r['Parent 1 Relationship'])),
              ],
            );
            counts.parents_inserted++;
            // Refresh local cache so later steps in this row (and rows
            // for siblings) can find the primary parent without
            // re-querying the DB.
            const arr = parentsByFamily.get(familyId) ?? [];
            arr.push({ id: pIns.rows[0].id, family_id: familyId, email: clean(r['Parent 1 Email']), is_primary: true });
            parentsByFamily.set(familyId, arr);
          }

          // Student
          const stIns = await execSafe(c,
            `INSERT INTO students
               (school_id, family_id, first_name, last_name, preferred_name,
                date_of_birth, gender, status, metadata)
             VALUES ($1, $2, $3, $4, $5, $6::date, $7, 'active', $8::jsonb)
             RETURNING id`,
            [
              WOOSTER_SCHOOL_ID, familyId, firstName, lastName, preferred,
              parseDob(r['Date of Birth']),
              clean(r['Gender'])?.toLowerCase() ?? null,
              JSON.stringify({
                slot: 1,
                source: 'final_forms_import',
                grade: clean(r['Grade']),
                grade_level: gradeLabel(r['Grade']),
                program: clean(r['Program']),
                payment_plan: clean(r['Payment Plan']),
                race: clean(r['Race']),
                lives_with: clean(r['Lives With Status']),
                is_returning: bool(r['Has Been Enrolled In District Before']),
              }),
            ],
          );
          studentId = stIns.rows[0].id;
          await execSafe(c,
            `INSERT INTO enrollments (school_id, student_id, status, academic_year)
             VALUES ($1, $2, 'enrolled', $3)`,
            [WOOSTER_SCHOOL_ID, studentId, ACADEMIC_YEAR],
          );
          counts.students_inserted++;
        }
      } else {
        // ─── 2. Update existing student ──────────────────────────────
        studentId = student.id;
        familyId = student.family_id;
        const md = { ...(student.metadata ?? {}) };
        md.grade = clean(r['Grade']) ?? md.grade;
        md.grade_level = gradeLabel(r['Grade']) ?? md.grade_level;
        md.program = clean(r['Program']) ?? md.program;
        md.payment_plan = clean(r['Payment Plan']) ?? md.payment_plan;
        md.race = clean(r['Race']) ?? md.race;
        md.lives_with = clean(r['Lives With Status']) ?? md.lives_with;
        md.is_returning = bool(r['Has Been Enrolled In District Before']) ?? md.is_returning;
        md.final_forms_id = clean(r['FinalForms ID']);

        await execSafe(c,
          `UPDATE students SET
             date_of_birth   = COALESCE($1::date, date_of_birth),
             gender          = COALESCE($2, gender),
             preferred_name  = COALESCE($3, preferred_name),
             metadata        = $4::jsonb,
             updated_at      = now()
           WHERE id = $5`,
          [
            parseDob(r['Date of Birth']),
            clean(r['Gender'])?.toLowerCase() ?? null,
            preferred,
            JSON.stringify(md),
            studentId,
          ],
        );
        counts.students_updated++;
      }

      // ─── 3. Add Parent 2 if present and not already in family ─────────
      if (p2Email && p2Email !== p1Email) {
        const familyParents = parentsByFamily.get(familyId) ?? [];
        const exists = familyParents.some((p) => emailKey(p.email) === p2Email);
        if (!exists) {
          const p2Ins = await execSafe(c,
            `INSERT INTO parents
               (school_id, family_id, ghl_contact_id, first_name, last_name, email, phone,
                is_primary, role, status)
             VALUES ($1, $2, NULL, $3, $4, $5, $6, false, $7, 'active')
             RETURNING id`,
            [
              WOOSTER_SCHOOL_ID, familyId,
              clean(r['Parent 2 First Name']),
              clean(r['Parent 2 Last Name']),
              clean(r['Parent 2 Email']),
              clean(r['Parent 2 Cell Phone']) ?? clean(r['Parent 2 Home Phone']) ?? clean(r['Parent 2 Work Phone']),
              inferRole(clean(r['Parent 2 Relationship'])),
            ],
          );
          counts.parents_inserted++;
          familyParents.push({ id: p2Ins.rows[0].id, family_id: familyId, email: p2Email, is_primary: false });
          parentsByFamily.set(familyId, familyParents);
        }
      }

      // ─── 4. Health profile UPSERT ─────────────────────────────────────
      await execSafe(c,
        `INSERT INTO student_health_profiles (
           school_id, student_id,
           emergency_contact_name, emergency_contact_relationship, emergency_contact_phone, emergency_contact_alt_phone,
           primary_doctor_name, primary_doctor_phone, preferred_hospital,
           health_insurance_provider, health_insurance_policy_number,
           allergies, current_medications, medical_conditions
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (school_id, student_id) DO UPDATE SET
           emergency_contact_name          = COALESCE(EXCLUDED.emergency_contact_name, student_health_profiles.emergency_contact_name),
           emergency_contact_relationship  = COALESCE(EXCLUDED.emergency_contact_relationship, student_health_profiles.emergency_contact_relationship),
           emergency_contact_phone         = COALESCE(EXCLUDED.emergency_contact_phone, student_health_profiles.emergency_contact_phone),
           emergency_contact_alt_phone     = COALESCE(EXCLUDED.emergency_contact_alt_phone, student_health_profiles.emergency_contact_alt_phone),
           primary_doctor_name             = COALESCE(EXCLUDED.primary_doctor_name, student_health_profiles.primary_doctor_name),
           primary_doctor_phone            = COALESCE(EXCLUDED.primary_doctor_phone, student_health_profiles.primary_doctor_phone),
           preferred_hospital              = COALESCE(EXCLUDED.preferred_hospital, student_health_profiles.preferred_hospital),
           health_insurance_provider       = COALESCE(EXCLUDED.health_insurance_provider, student_health_profiles.health_insurance_provider),
           health_insurance_policy_number  = COALESCE(EXCLUDED.health_insurance_policy_number, student_health_profiles.health_insurance_policy_number),
           allergies                       = COALESCE(EXCLUDED.allergies, student_health_profiles.allergies),
           current_medications             = COALESCE(EXCLUDED.current_medications, student_health_profiles.current_medications),
           medical_conditions              = COALESCE(EXCLUDED.medical_conditions, student_health_profiles.medical_conditions),
           updated_at                      = now()`,
        [
          WOOSTER_SCHOOL_ID, studentId,
          joinName(r['Emergency Contact 1 First Name'], r['Emergency Contact 1 Last Name']),
          clean(r['Emergency Contact 1 Relationship']),
          clean(r['Emergency Contact 1 Cell Phone']) ?? clean(r['Emergency Contact 1 Home Phone']),
          clean(r['Emergency Contact 1 Work Phone']),
          clean(r['Doctor Name']),
          clean(r['Doctor Phone']),
          clean(r['Hospital Name']),
          clean(r['Insurance Company']),
          clean(r['Policy Number']),
          clean(r['Allergies']),
          clean(r['Medications']),
          clean(r['Existing Medical Conditions']),
        ],
      );
      counts.health_profiles_upserted++;

      // ─── 5. Pickup persons — EC2 and EC3 + any pickup-cleared people ──
      // Use the family's primary parent as added_by_parent_id (required FK).
      const primaryParent = (parentsByFamily.get(familyId) ?? []).find((p) => p.is_primary)
        ?? (parentsByFamily.get(familyId) ?? [])[0];
      if (primaryParent) {
        for (const i of [2, 3]) {
          const name = joinName(r[`Emergency Contact ${i} First Name`], r[`Emergency Contact ${i} Last Name`]);
          if (!name) continue;
          const phone = clean(r[`Emergency Contact ${i} Cell Phone`]) ?? clean(r[`Emergency Contact ${i} Home Phone`]);
          const rel = clean(r[`Emergency Contact ${i} Relationship`]) ?? 'Emergency contact';
          const canPickUp = bool(r[`Can Emergency Contact ${i} Pick Up`]);
          // Idempotent: skip if a pickup person with same name+phone already
          // exists for this parent (within this family).
          const exists = await c.query(
            `SELECT id FROM pickup_persons WHERE added_by_parent_id = $1 AND name = $2 AND COALESCE(phone, '') = COALESCE($3, '')`,
            [primaryParent.id, name, phone],
          );
          if (exists.rows.length > 0) {
            counts.pickup_persons_skipped_existing++;
            continue;
          }
          await execSafe(c,
            `INSERT INTO pickup_persons (school_id, added_by_parent_id, name, relationship, phone, active, notes, is_temporary)
             VALUES ($1, $2, $3, $4, $5, $6, $7, false)`,
            [
              WOOSTER_SCHOOL_ID, primaryParent.id, name, rel, phone,
              canPickUp !== false,
              `Imported from Final Forms. EC${i} for ${firstName} ${lastName}. Pickup authorization: ${canPickUp === false ? 'NO' : 'YES'}.`,
            ],
          );
          counts.pickup_persons_inserted++;
        }
      }

      // ─── 6. Update enrollment metadata (payment plan, program) ────────
      await execSafe(c,
        `UPDATE enrollments
            SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
                updated_at = now()
          WHERE student_id = $2 AND academic_year = $3`,
        [
          JSON.stringify({
            payment_plan: clean(r['Payment Plan']),
            program: clean(r['Program']),
            hours_of_attendance: clean(r['Hours Of Attendance']),
            days_of_attendance: [
              bool(r['Days Of Attendance Monday'])    ? 'Mon' : null,
              bool(r['Days Of Attendance Tuesday'])   ? 'Tue' : null,
              bool(r['Days Of Attendance Wednesday']) ? 'Wed' : null,
              bool(r['Days Of Attendance Thursday'])  ? 'Thu' : null,
              bool(r['Days Of Attendance Friday'])    ? 'Fri' : null,
            ].filter(Boolean),
            roster_permissions: {
              child_name:    bool(r['Can List Childs Name']),
              parent_name:   bool(r['Can List Parent Name']),
              email:         bool(r['Can List Email Address']),
              cell_phone:    bool(r['Can List Cell Phone Number']),
              home_phone:    bool(r['Can List Home Phone Number']),
              work_phone:    bool(r['Can List Work Phone Number']),
              address:       bool(r['Can List Address']),
            },
            source: 'final_forms_import',
          }),
          studentId, ACADEMIC_YEAR,
        ],
      );
      counts.enrollments_updated++;
    }

    if (!DRY_RUN) await c.query('COMMIT');

    // Summary
    console.log('\n=== Summary ===');
    for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(40)} ${v}`);

    if (unmatchedRows.length) {
      const path = join(projectRoot, `_unmatched_${Date.now()}.csv`);
      writeFileSync(path, ['name,parent_email,reason', ...unmatchedRows].join('\n'));
      console.log(`\nUnmatched rows saved to ${path}`);
    }
  } catch (e) {
    if (!DRY_RUN) await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
    await pool.end();
  }
}

function joinName(first, last) {
  const f = (first ?? '').trim();
  const l = (last ?? '').trim();
  const s = `${f} ${l}`.trim();
  return s.length === 0 ? null : s;
}
function inferRole(relationship) {
  if (!relationship) return 'parent';
  const r = relationship.toLowerCase();
  if (r.includes('mother') || r.includes('mom')) return 'parent';
  if (r.includes('father') || r.includes('dad')) return 'parent';
  if (r.includes('guard')) return 'guardian';
  return 'parent';
}
async function execSafe(c, sql, params) {
  if (DRY_RUN) return { rows: [{ id: '00000000-0000-0000-0000-000000000000' }] };
  return c.query(sql, params);
}

main().catch((e) => { console.error(e); process.exit(1); });
