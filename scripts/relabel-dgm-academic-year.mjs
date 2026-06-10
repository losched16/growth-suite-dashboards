// Segment DGM by academic year.
//   - Students IN the 6-8 sheet (263)  -> 2026-27 (current). Ensure each
//     has an 'enrolled' 2026-27 enrollment.
//   - Students NOT in the sheet (the 91 etc.) -> relabel their 2026-27
//     enrollments to 2025-26 (old). Records stay active; just the year moves.
//
//   node scripts/relabel-dgm-academic-year.mjs            # DRY-RUN
//   node scripts/relabel-dgm-academic-year.mjs --apply
import { readFileSync } from 'node:fs';
import pg from 'pg';

const SCHOOL_ID = 'cfa9030d-c8fe-49ae-a9e7-f1003844ec07';
const CURRENT = '2026-27';
const OLD = '2025-26';
const APPLY = process.argv.includes('--apply');

for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('='); if (eq < 0) continue;
  const k = t.slice(0, eq).trim();
  if (!process.env[k]) process.env[k] = t.slice(eq + 1).trim().replace(/^"|"$/g, '');
}

const sheetUids = new Set(JSON.parse(readFileSync('scripts/.dgm_sheet_uids.json', 'utf8')));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// All active DGM students + their unique_id + whether they have a 2026-27 enrolled row
const studs = (await pool.query(
  `SELECT s.id, s.first_name, s.last_name, s.metadata->>'unique_id' uid,
          EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id=s.id AND e.academic_year=$2 AND e.status='enrolled') has_cur,
          EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id=s.id AND e.academic_year=$2) has_cur_any
     FROM students s WHERE s.school_id=$1 AND s.status='active'`,
  [SCHOOL_ID, CURRENT],
)).rows;

const inSheet = studs.filter((s) => s.uid && sheetUids.has(s.uid));
const notInSheet = studs.filter((s) => !(s.uid && sheetUids.has(s.uid)));

console.log(`mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
console.log(`active students: ${studs.length}  in-sheet(2026-27): ${inSheet.length}  not-in-sheet(->2025-26): ${notInSheet.length}`);

// 1) Relabel non-sheet students' 2026-27 enrollments -> 2025-26
const notIds = notInSheet.map((s) => s.id);
let relabeled = 0;
if (notIds.length) {
  if (APPLY) {
    const r = await pool.query(
      `UPDATE enrollments SET academic_year=$3, updated_at=now()
        WHERE student_id = ANY($1::uuid[]) AND academic_year=$2 RETURNING id`,
      [notIds, CURRENT, OLD],
    );
    relabeled = r.rowCount;
  } else {
    const r = await pool.query(
      `SELECT COUNT(*)::int n FROM enrollments WHERE student_id = ANY($1::uuid[]) AND academic_year=$2`,
      [notIds, CURRENT],
    );
    relabeled = r.rows[0].n;
  }
}
console.log(`${APPLY ? 'relabeled' : 'would relabel'} ${relabeled} enrollments ${CURRENT} -> ${OLD} (non-sheet students)`);

// 2) Ensure in-sheet students have a 2026-27 enrolled enrollment
const missing = inSheet.filter((s) => !s.has_cur);
let created = 0;
for (const s of missing) {
  if (APPLY) {
    // don't duplicate if a non-enrolled 2026-27 row exists; just insert enrolled
    await pool.query(
      `INSERT INTO enrollments (student_id, school_id, academic_year, status, enrolled_at, metadata)
       VALUES ($1,$2,$3,'enrolled', now(), '{}'::jsonb)`,
      [s.id, SCHOOL_ID, CURRENT],
    );
  }
  created++;
}
console.log(`${APPLY ? 'created' : 'would create'} ${created} missing 2026-27 enrollments for in-sheet students`);

// post-state preview
if (APPLY) {
  const after = await pool.query(
    `SELECT e.academic_year, COUNT(DISTINCT s.id)::int students
       FROM students s JOIN enrollments e ON e.student_id=s.id
      WHERE s.school_id=$1 AND s.status='active' AND e.status='enrolled'
      GROUP BY 1 ORDER BY 1 DESC`, [SCHOOL_ID]);
  console.log('\nafter — enrolled students by year:', JSON.stringify(after.rows));
}

if (!APPLY) console.log('\nDRY-RUN — nothing written. Re-run with --apply.');
await pool.end();
