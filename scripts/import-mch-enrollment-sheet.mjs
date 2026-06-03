// Import MCH's master Growth Suite Enrollment Sheet — the canonical
// per-family schedule + extended-care + parent + address data set.
//
// Source: mch-forms/Growth Suite Enrollment Sheet.xlsx (sibling repo root)
//
// What this replaces:
//   - The simpler scripts/import-mch-tuition-survey.mjs (which only
//     captured payment plan + assumed everyone was "5 Days, Full Day")
//   - Manual GHL parent contact entry
//   - Manual extended-care tier assignment
//
// Per-row, the importer:
//   1. Matches the student (by name + family) — creates new student row
//      if missing (handles waitlist rows that aren't yet in DB).
//   2. Determines program (YC / Primary / Kindergarten) from column
//      flags + classroom + age fallback.
//   3. Parses Days column → days/week count; Times column → full vs half.
//   4. Looks up the matching tuition_grid by (program × days × full/half).
//   5. Maps Extended care text to one of the 4 tiers and looks up the
//      annual cost from the rate matrix (tier × days/week).
//   6. Reads tuition credit + development fee from the Excel.
//   7. Joins to the payment plan from the prior survey-import (defaults
//      to 'monthly' if no survey response found).
//   8. Upserts family_tuition_enrollments with the right grid + plan +
//      total amount + addons jsonb (extended care, dev fee, credit).
//   9. Adds the second parent if not already on file; updates addresses.
//  10. Updates student.metadata with classroom, allergies, schedule.
//
// Pair with: writeback-mch-tuition-ghl.mjs (existing) to push the
// finished numbers back to each parent's GHL contact.
//
// Usage:
//   node scripts/import-mch-enrollment-sheet.mjs               # apply
//   node scripts/import-mch-enrollment-sheet.mjs --dry-run     # report-only

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
// xlsx ships ESM with the named API on the default export in some
// versions and as top-level in others. Use the default import + read
// from the bytes ourselves so it works on both.
import XLSX from 'xlsx';

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

const args = parseArgs(process.argv.slice(2));
const MCH_SCHOOL_ID = 'a6c4b2dd-050c-4bf9-893b-67106f0f20e8';
const ACADEMIC_YEAR = '2026-27';
const EXCEL_PATH = join(projectRoot, '..', 'mch-forms', 'Growth Suite Enrollment Sheet.xlsx');

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── Extended-care rate matrix (annual, in cents) ─────────────────
// From the Schedule of Tuitions PDF. Rows = tier; columns = days/week.
// Days < 2 fall through to per-diem ($17/hr); we don't model that here
// — flag for manual review.
const EXT_CARE_MATRIX_CENTS = {
  '1':  { 2:  97500, 3: 136500, 4: 172000, 5: 202500 },  // "1 hour or less"
  '2':  { 2: 172500, 3: 230000, 4: 286500, 5: 330000 },  // ">1 hour, up to 2 hours"
  '3':  { 2: 230000, 3: 313000, 4: 357000, 5: 400000 },  // ">2 hours, up to 3 hours"
  '4':  { 2: 285000, 3: 357000, 4: 404000, 5: 467500 },  // ">3 hours"
};

// Map Excel's free-text "Extended care" cell to a tier.
function mapExtendedCareTier(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s || s === '0' || s === '0.0' || s === 'none' || s === '-') return null;
  if (s.includes('1 hour or less') || s === '1 hour' || s === '1hr')         return '1';
  if (s.includes('1 hour') && s.includes('2 hours'))                          return '2';
  if (s.includes('1 hours, up to 2'))                                          return '2';  // matches the Excel typo
  if (s.includes('2 hours') && s.includes('3 hours'))                          return '3';
  if (s.includes('more than 3') || s.includes('>3') || s.includes('3+'))      return '4';
  return null; // unknown → caller treats as 0
}

// Parse the "Days" column into { count, half_full }. count is 2-5.
// half_full is 'half' | 'full'.
//
// Handles several shapes seen in MCH's Excel:
//   "M-F Full"               → 5 full
//   "MWF"                    → 3 full (inferred from times)
//   "MTWTHF"                 → 5 (TH is one day)
//   "MW Full"                → 2 full
//   "TWTH"                   → 3
//   "MW Full 8:45am - 4:30pm TTHF 8:45AM-2:45PM"  → 5 (two patterns combined)
//
// The combined-pattern case requires us to strip times + AM/PM tokens
// BEFORE counting day letters, otherwise the M in "AM" gets counted as
// a Monday.
function parseDays(raw, times) {
  let s = String(raw ?? '').toUpperCase();
  let halfFull = null;
  if (s.includes('FULL')) halfFull = 'full';
  else if (s.includes('HALF') || s.includes('HAL')) halfFull = 'half';

  // Strip noise so day-letter counting is clean. Order matters: kill
  // AM/PM tokens first so the M in "AM" doesn't survive.
  let cleaned = s
    .replace(/\d+(?::\d+)?\s*[AP]M/g, '') // "8:45AM", "4:30 PM"
    .replace(/\d+(?::\d+)?/g, '')         // bare times "8:45"
    .replace(/[AP]M/g, '')                // bare AM/PM
    .replace(/[:,;]/g, ' ')               // punctuation → spaces
    .replace(/\bFULL\b/g, '')
    .replace(/\bHALF?\b/g, '')
    .trim();

  // M-F shorthand = full work week.
  if (/M\s*-\s*F/.test(cleaned)) return { count: 5, half_full: halfFull };

  // Walk char-by-char counting day letters. TH = Thursday (1 day, 2 chars).
  let count = 0;
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (c === ' ' || c === '-') continue;
    if (c === 'T' && cleaned[i + 1] === 'H') { count++; i++; continue; }
    if ('MTWF'.includes(c)) count++;
  }
  if (count < 1) count = 5;
  if (count > 5) count = 5; // safety cap — never charge >5-day rate

  // If neither Full nor Half appeared in Days, infer from Times.
  if (!halfFull) {
    const t = String(times ?? '').toLowerCase();
    halfFull = (t.includes('11:30') || t.includes('11:45')) ? 'half' : 'full';
  }
  return { count, half_full: halfFull };
}

// Pick program from the YC / Primary / Kindergarten flag columns. Falls
// back to the classroom + age heuristic from import-mch-tuition-survey.
function pickProgram(ycFlag, pFlag, kFlag, classroom, dob) {
  const truthy = (v) => !!String(v ?? '').trim();
  if (truthy(kFlag))  return 'Kindergarten';
  if (truthy(pFlag))  return 'Primary';
  if (truthy(ycFlag)) return 'Young Community';

  // No flag — fall back to classroom + age. Rose / Buttercup are YC;
  // Tulip / Sunflower are Primary; oldest kids (5+) go to Kindergarten.
  const c = String(classroom ?? '').toLowerCase();
  const age = dob ? (new Date('2026-09-01').getTime() - new Date(dob).getTime()) / (365.25 * 86400_000) : null;
  if (age !== null && age >= 5) return 'Kindergarten';
  if (c === 'rose' || c === 'buttercup') return 'Young Community';
  if (c === 'tulip' || c === 'sunflower') return 'Primary';
  return age !== null && age < 3 ? 'Young Community' : 'Primary';
}

// Compose the grid display name to match what's in tuition_grids today.
// We seeded grids only for 2/3/5 days. 4-day schedules round UP to 5
// days (MCH charges the 5-day rate for 4-day commitments — staff seat
// is held). Surfaced in the report as a note so the operator knows.
function gridDisplayName(program, daysCount, halfFull) {
  const effective = daysCount === 4 ? 5 : daysCount;  // round 4 → 5
  if (program === 'Kindergarten') {
    return 'Kindergarten — 5 Full Days (8:30am–3:15pm)';
  }
  const dayLabel = `${effective} Days`;
  const hfLabel = halfFull === 'half' ? 'Half Day' : 'Full Day';

  // Match the exact display_name strings we seeded. Includes the
  // parenthetical time spec on the 2-day YC + 3-day Primary rows.
  if (program === 'Young Community') {
    if (effective === 2 && halfFull === 'half') return 'YC — 2 Days, Half Day (9am–11:30am)';
    if (effective === 2 && halfFull === 'full') return 'YC — 2 Days, Full Day (9am–2:45pm)';
    return `YC — ${dayLabel}, ${hfLabel}`;
  }
  if (program === 'Primary') {
    if (effective === 3 && halfFull === 'half') return 'Primary — 3 Days, Half Day (8:45am–11:45am)';
    if (effective === 3 && halfFull === 'full') return 'Primary — 3 Days, Full Day (8:45am–2:45pm)';
    return `Primary — ${dayLabel}, ${hfLabel}`;
  }
  return null;
}

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ');

// DB typos in MCH's students table — same aliases I added earlier.
const STUDENT_NAME_ALIASES = {
  'vihaan suthar':        'vlhaan suthar',
  'madison korzeniowski': 'madison koreniowski',
};

async function findStudent(firstName, lastName, dob) {
  const aliased = STUDENT_NAME_ALIASES[norm(`${firstName} ${lastName}`)];
  const [aFirst, aLast] = aliased ? aliased.split(' ', 2) : [firstName, lastName];

  // First+last+dob (most specific)
  if (dob) {
    const r = await pool.query(
      `SELECT id, family_id FROM students
        WHERE school_id = $1
          AND LOWER(first_name) = LOWER($2)
          AND LOWER(REPLACE(last_name, '''', '''')) = LOWER(REPLACE($3, '''', ''''))
          AND date_of_birth = $4::date
          AND status = 'active' LIMIT 1`,
      [MCH_SCHOOL_ID, aFirst, aLast, dob],
    );
    if (r.rowCount) return r.rows[0];
  }
  // First+last (no dob fallback)
  const r = await pool.query(
    `SELECT id, family_id FROM students
      WHERE school_id = $1
        AND LOWER(first_name) = LOWER($2)
        AND LOWER(REPLACE(last_name, '''', '''')) = LOWER(REPLACE($3, '''', ''''))
        AND status = 'active' LIMIT 1`,
    [MCH_SCHOOL_ID, aFirst, aLast],
  );
  return r.rowCount ? r.rows[0] : null;
}

async function findOrCreateFamilyByParentEmail(parentEmail, parentFirst, parentLast, parentPhone, address, displayName) {
  const e = norm(parentEmail);
  if (!e) throw new Error('Cannot create family — missing primary parent email');

  // Existing parent?
  const r = await pool.query(
    `SELECT id, family_id FROM parents
      WHERE school_id = $1 AND LOWER(email) = $2 AND status = 'active' LIMIT 1`,
    [MCH_SCHOOL_ID, e],
  );
  if (r.rowCount) return { family_id: r.rows[0].family_id, parent_id: r.rows[0].id, created: false };

  // Create family + primary parent.
  const famIns = await pool.query(
    `INSERT INTO families (school_id, display_name) VALUES ($1, $2) RETURNING id`,
    [MCH_SCHOOL_ID, displayName || `${parentLast} Family`],
  );
  const familyId = famIns.rows[0].id;
  const parIns = await pool.query(
    `INSERT INTO parents (school_id, family_id, first_name, last_name, email, phone, is_primary, status, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, true, 'active', $7::jsonb) RETURNING id`,
    [MCH_SCHOOL_ID, familyId, parentFirst, parentLast, e, parentPhone, JSON.stringify({ address: address || null })],
  ).catch(async (err) => {
    // metadata column may not exist on parents — retry without it
    if (String(err.message).includes('column "metadata"')) {
      return pool.query(
        `INSERT INTO parents (school_id, family_id, first_name, last_name, email, phone, is_primary, status)
         VALUES ($1, $2, $3, $4, $5, $6, true, 'active') RETURNING id`,
        [MCH_SCHOOL_ID, familyId, parentFirst, parentLast, e, parentPhone],
      );
    }
    throw err;
  });
  return { family_id: familyId, parent_id: parIns.rows[0].id, created: true };
}

async function upsertSecondaryParent(familyId, parentFirst, parentLast, parentEmail, parentPhone, address) {
  const e = norm(parentEmail);
  if (!e || !parentFirst || !parentLast) return { skipped: true };
  // Already on file?
  const r = await pool.query(
    `SELECT id FROM parents
      WHERE school_id = $1 AND LOWER(email) = $2 AND status = 'active' LIMIT 1`,
    [MCH_SCHOOL_ID, e],
  );
  if (r.rowCount) return { id: r.rows[0].id, created: false };
  const ins = await pool.query(
    `INSERT INTO parents (school_id, family_id, first_name, last_name, email, phone, is_primary, status)
     VALUES ($1, $2, $3, $4, $5, $6, false, 'active') RETURNING id`,
    [MCH_SCHOOL_ID, familyId, parentFirst, parentLast, e, parentPhone],
  );
  void address; // address storage TODO — depends on the parents.metadata column existing
  return { id: ins.rows[0].id, created: true };
}

async function findOrCreateStudent(firstName, lastName, dob, familyId, metadata) {
  const existing = await findStudent(firstName, lastName, dob);
  if (existing) {
    // Refresh metadata fields if Excel has new values
    await pool.query(
      `UPDATE students
          SET metadata = COALESCE(metadata, '{}'::jsonb)
                      || COALESCE($2::jsonb, '{}'::jsonb),
              updated_at = now()
        WHERE id = $1`,
      [existing.id, JSON.stringify(metadata)],
    ).catch(() => undefined);
    return { id: existing.id, created: false };
  }
  const ins = await pool.query(
    `INSERT INTO students (school_id, family_id, first_name, last_name, date_of_birth, metadata, status)
     VALUES ($1, $2, $3, $4, $5::date, $6::jsonb, 'active') RETURNING id`,
    [MCH_SCHOOL_ID, familyId, firstName, lastName, dob, JSON.stringify(metadata)],
  );
  return { id: ins.rows[0].id, created: true };
}

// Look up the family's payment plan from the previous survey-import.
// Defaults to monthly (10-pay) when no survey response exists for the
// family — that's MCH's most common selection.
async function lookupPaymentPlan(familyId, planSlugByEnrollment) {
  // The simpler import-mch-tuition-survey.mjs already created enrollments
  // with payment_plan_id set per family. Re-use that.
  const r = await pool.query(
    `SELECT pp.slug FROM family_tuition_enrollments fte
       JOIN payment_plans pp ON pp.id = fte.payment_plan_id
      WHERE fte.school_id = $1 AND fte.family_id = $2 AND fte.status = 'active'
      ORDER BY fte.created_at DESC LIMIT 1`,
    [MCH_SCHOOL_ID, familyId],
  );
  if (r.rowCount) return r.rows[0].slug;
  // Caller-provided fallback (when we cache the survey responses up-front)
  return planSlugByEnrollment ?? 'monthly';
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  console.log(`Importing MCH enrollment sheet${args.dryRun ? ' (DRY RUN — no writes)' : ''}\n`);
  console.log(`Source: ${EXCEL_PATH}\n`);

  // Read file bytes ourselves and let xlsx parse from buffer — works
  // across the package's various ESM/CJS export shapes.
  const buf = readFileSync(EXCEL_PATH);
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null, header: 1 });

  // First two rows are header + a totals/legend row; data starts at row 2.
  const dataRows = rows.slice(2).filter((r) => r && r[3]); // need a Name in col 3

  // Cache plans + grids
  const { rows: grids } = await pool.query(
    `SELECT id, display_name, annual_tuition_cents FROM tuition_grids
      WHERE school_id = $1 AND academic_year = $2 AND is_active = true`,
    [MCH_SCHOOL_ID, ACADEMIC_YEAR],
  );
  const gridByName = new Map(grids.map((g) => [g.display_name, g]));
  const { rows: plans } = await pool.query(
    `SELECT id, slug, installment_count, discount_basis_points, schedule_template
       FROM payment_plans WHERE school_id = $1 AND is_active = true`,
    [MCH_SCHOOL_ID],
  );
  const planBySlug = new Map(plans.map((p) => [p.slug, p]));

  let okCount = 0, skipCount = 0, errCount = 0;
  let newStudents = 0, newFamilies = 0, newParents = 0;
  const fourDayNotes = []; // surface 4-day → 5-day rounding decisions
  const errors = [];

  for (const row of dataRows) {
    // Excel column indices (0-based):
    // 3 Name | 4 Days | 5 Times | 6 Tuition credit | 7 Sibling disc | 8 Extended care
    // 9 Dev fee | 11 Room | 12 Allergies | 13 First | 14 Last
    // 15 G1 name | 16 G1 email | 17 G1 phone | 18 G2 name | 19 G2 email | 20 G2 phone
    // 21 Address | 22 Address P2 | 23 Birthday
    // 31 YC | 32 Primary | 33 Kindergarten
    const namePair = String(row[3] ?? '').trim();
    if (!namePair || namePair === 'TOTAL COUNT') continue;

    let firstName, lastName;
    if (namePair.includes(',')) {
      const [ln, fn] = namePair.split(',', 2);
      lastName = ln.trim();
      firstName = fn.trim();
    } else {
      // Fall back to the separate First / Last columns
      firstName = String(row[13] ?? '').trim();
      lastName  = String(row[14] ?? '').trim();
    }
    if (!firstName || !lastName) {
      errors.push(`Could not parse student name from row: "${namePair}"`);
      errCount++; continue;
    }

    const dobRaw = row[23];
    const dob = dobRaw instanceof Date ? dobRaw.toISOString().slice(0, 10) : (dobRaw ? String(dobRaw).slice(0, 10) : null);
    const classroom = String(row[11] ?? '').trim() || null;
    const days = parseDays(row[4], row[5]);
    const extTierKey = mapExtendedCareTier(row[8]);
    // Guard against non-numeric cell values (some operators type
    // "not paid yet" or "TBD" into the dev fee / credit columns).
    const toNumberOrZero = (v, fallback = 0) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    };
    const devFeeCents = Math.round(toNumberOrZero(row[9], 200) * 100);
    const creditCents = Math.round(toNumberOrZero(row[6], 0) * 100);  // col 6 = tuition credit ($400 deposit applied)
    const allergies = String(row[12] ?? '').trim() || null;
    const program = pickProgram(row[31], row[32], row[33], classroom, dob);

    // Resolve the grid.
    const gridName = gridDisplayName(program, days.count, days.half_full);
    if (!gridName) {
      errors.push(`${firstName} ${lastName}: couldn't compose grid name for program=${program}, days=${days.count}, ${days.half_full}`);
      errCount++; continue;
    }
    const grid = gridByName.get(gridName);
    if (!grid) {
      errors.push(`${firstName} ${lastName}: grid "${gridName}" not found — provision it first.`);
      errCount++; continue;
    }
    if (days.count === 4) {
      fourDayNotes.push(`${firstName} ${lastName}: charged 5-day rate ($${(grid.annual_tuition_cents/100).toLocaleString()}) for 4-day enrollment.`);
    }

    // Extended-care annual amount.
    let extCents = 0, extLabel = null;
    if (extTierKey) {
      // 4-day extended care uses 4 in the matrix; 5-day uses 5. We use
      // the EFFECTIVE day count (rounding doesn't apply to ext care).
      const dayKey = Math.min(5, Math.max(2, days.count));
      extCents = EXT_CARE_MATRIX_CENTS[extTierKey]?.[dayKey] ?? 0;
      const tierName = { '1': '≤1 hour', '2': '1-2 hours', '3': '2-3 hours', '4': '>3 hours' }[extTierKey];
      extLabel = `Extended care: ${tierName}, ${dayKey} days/week`;
    }

    // Parents.
    const p1Email = String(row[16] ?? '').trim().toLowerCase();
    const p1Name = String(row[15] ?? '').trim();
    const [p1First, ...p1RestArr] = p1Name.split(' ');
    const p1Last = p1RestArr.join(' ').trim();
    const p1Phone = String(row[17] ?? '').trim() || null;
    const address = String(row[21] ?? '').trim() || null;

    const p2Name = String(row[18] ?? '').trim();
    const [p2First, ...p2RestArr] = p2Name.split(' ');
    const p2Last = p2RestArr.join(' ').trim();
    const p2Email = String(row[19] ?? '').trim().toLowerCase();
    const p2Phone = String(row[20] ?? '').trim() || null;
    const addressP2 = String(row[22] ?? '').trim() || null;

    // Sibling fallback when the row is missing a primary parent email
    // (some Excel rows for siblings only list the parent's name on the
    // first sibling's row). Look for an existing family with a student
    // sharing this row's last name; reuse that family if found.
    let siblingFallbackFamilyId = null;
    if (!p1Email) {
      const sib = await pool.query(
        `SELECT family_id FROM students
          WHERE school_id = $1
            AND LOWER(REPLACE(last_name, '''', '''')) = LOWER(REPLACE($2, '''', ''''))
            AND status = 'active'
            AND first_name <> $3
          ORDER BY created_at ASC LIMIT 1`,
        [MCH_SCHOOL_ID, lastName, firstName],
      );
      if (sib.rowCount) {
        siblingFallbackFamilyId = sib.rows[0].family_id;
      } else {
        errors.push(`${firstName} ${lastName}: no primary parent email AND no sibling already on file to inherit family from.`);
        errCount++; continue;
      }
    }

    if (args.dryRun) {
      const planSlug = await lookupPaymentPlan(/* family unknown until apply */ null);
      const totalBeforeDiscount = grid.annual_tuition_cents + extCents + devFeeCents - creditCents;
      const plan = planBySlug.get(planSlug ?? 'monthly');
      const disc = plan?.discount_basis_points ?? 0;
      const total = Math.round(totalBeforeDiscount * (1 - disc / 10000));
      console.log(`  • DRY ${firstName.padEnd(12)} ${lastName.padEnd(15)} ${(classroom||'-').padEnd(10)} → ${program.padEnd(15)} ${gridName.replace(/Young Community/, 'YC').slice(0, 38).padEnd(38)} ext:${(extCents/100).toFixed(0).padStart(5)} dev:${(devFeeCents/100).toFixed(0)} cr:-${(creditCents/100).toFixed(0)} = $${(total/100).toLocaleString()}/yr`);
      okCount++;
      continue;
    }

    // APPLY mode — find or create family/parents/student, then upsert enrollment.
    try {
      let family;
      if (siblingFallbackFamilyId) {
        family = { family_id: siblingFallbackFamilyId, parent_id: null, created: false };
      } else {
        family = await findOrCreateFamilyByParentEmail(
          p1Email, p1First, p1Last, p1Phone, address, `${lastName} Family`,
        );
        if (family.created) newFamilies++;
      }

      if (p2Email) {
        const sec = await upsertSecondaryParent(family.family_id, p2First, p2Last, p2Email, p2Phone, addressP2);
        if (sec.created) newParents++;
      }

      const studentMeta = {
        classroom,
        allergy: allergies,
        schedule_days: row[4] ?? null,
        schedule_times: row[5] ?? null,
        program,
      };
      const student = await findOrCreateStudent(firstName, lastName, dob, family.family_id, studentMeta);
      if (student.created) newStudents++;

      const planSlug = await lookupPaymentPlan(family.family_id);
      const plan = planBySlug.get(planSlug);
      if (!plan) {
        errors.push(`${firstName} ${lastName}: payment plan "${planSlug}" not found.`);
        errCount++; continue;
      }

      // Compose addons array. Negative tuition_credit nets against
      // subtotal so total_annual_cents reflects the final amount due.
      const addons = [];
      if (extCents > 0)    addons.push({ key: 'extended_care',   label: extLabel, amount_cents: extCents });
      if (devFeeCents > 0) addons.push({ key: 'development_fee', label: 'Development fee', amount_cents: devFeeCents });
      if (creditCents > 0) addons.push({ key: 'tuition_credit',  label: 'Tuition credit (deposit applied)', amount_cents: -creditCents });

      const baseAnnual = grid.annual_tuition_cents + extCents + devFeeCents - creditCents;
      const totalAnnual = Math.round(baseAnnual * (1 - plan.discount_basis_points / 10000));

      const existing = await pool.query(
        `SELECT id FROM family_tuition_enrollments
          WHERE school_id = $1 AND family_id = $2 AND student_id = $3 AND academic_year = $4`,
        [MCH_SCHOOL_ID, family.family_id, student.id, ACADEMIC_YEAR],
      );

      if (existing.rowCount > 0) {
        await pool.query(
          `UPDATE family_tuition_enrollments
              SET tuition_grid_id = $1, payment_plan_id = $2,
                  annual_tuition_cents = $3, plan_discount_basis_points = $4,
                  addons = $5::jsonb, total_annual_cents = $6,
                  installment_count = $7, schedule = $8::jsonb,
                  status = 'active', updated_at = now()
            WHERE id = $9`,
          [grid.id, plan.id, grid.annual_tuition_cents, plan.discount_basis_points,
           JSON.stringify(addons), totalAnnual, plan.installment_count,
           JSON.stringify(plan.schedule_template), existing.rows[0].id],
        );
      } else {
        await pool.query(
          `INSERT INTO family_tuition_enrollments
             (school_id, family_id, student_id, academic_year,
              tuition_grid_id, payment_plan_id,
              annual_tuition_cents, plan_discount_basis_points, addons,
              total_annual_cents, installment_count, schedule,
              status, internal_note, created_by_email)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb,
                   $10, $11, $12::jsonb, 'active',
                   'Imported from Growth Suite Enrollment Sheet', 'enrollment-import@growthsuite.local')`,
          [MCH_SCHOOL_ID, family.family_id, student.id, ACADEMIC_YEAR,
           grid.id, plan.id, grid.annual_tuition_cents, plan.discount_basis_points,
           JSON.stringify(addons), totalAnnual, plan.installment_count,
           JSON.stringify(plan.schedule_template)],
        );
      }

      console.log(`  ✓ ${firstName.padEnd(12)} ${lastName.padEnd(15)} → ${program.padEnd(15)} ${planSlug.padEnd(12)} $${(totalAnnual/100).toLocaleString().padStart(7)}/yr` +
                  (student.created ? ' [+student]' : '') +
                  (family.created  ? ' [+family]'  : ''));
      okCount++;
    } catch (e) {
      errors.push(`${firstName} ${lastName}: ${e.message}`);
      errCount++;
    }
  }

  console.log(`\nDone. ${okCount} ok, ${errCount} errors, ${skipCount} skipped.`);
  if (!args.dryRun) {
    console.log(`Created: ${newStudents} new students, ${newFamilies} new families, ${newParents} new secondary parents.`);
  }
  if (fourDayNotes.length > 0) {
    console.log(`\n4-day → 5-day rate (${fourDayNotes.length} families):`);
    for (const n of fourDayNotes.slice(0, 20)) console.log(`  • ${n}`);
    if (fourDayNotes.length > 20) console.log(`  …and ${fourDayNotes.length - 20} more`);
  }
  if (errors.length > 0) {
    console.log(`\nErrors:`);
    for (const e of errors.slice(0, 30)) console.log(`  ✗ ${e}`);
    if (errors.length > 30) console.log(`  …and ${errors.length - 30} more`);
  }
  if (!args.dryRun) {
    console.log(`\nNext steps:`);
    console.log(`  • Push to GHL: npx tsx scripts/writeback-mch-tuition-ghl.mjs`);
    console.log(`  • Verify parent portal: log in as Isha Suthar or Laura Zakorchemny`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => pool.end());

function parseArgs(argv) {
  return { dryRun: argv.includes('--dry-run') };
}
