// Future-proofing: snapshot each DGM student's year-specific fields
// (tuition, program, grade, homeroom, payment plan, schedule) from
// students.metadata onto THEIR enrollment.metadata — the per-year row.
//
// Why: today these live only on the student (one value), so a re-import
// overwrites them and the prior year's numbers are lost. Stamping them
// onto the enrollment preserves each year's snapshot permanently, even
// when the student record is later refreshed. The roster reads from the
// student for now; this protects history for when reads move to the
// enrollment + for any audit.
//
//   node scripts/snapshot-dgm-enrollment-year-data.mjs            # DRY-RUN
//   node scripts/snapshot-dgm-enrollment-year-data.mjs --apply
import { readFileSync } from 'node:fs';
import pg from 'pg';

const SCHOOL_ID = 'cfa9030d-c8fe-49ae-a9e7-f1003844ec07';
const APPLY = process.argv.includes('--apply');
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('='); if (eq < 0) continue;
  const k = t.slice(0, eq).trim();
  if (!process.env[k]) process.env[k] = t.slice(eq + 1).trim().replace(/^"|"$/g, '');
}

const YEAR_KEYS = [
  'program_tuition', 'tuition_fee', 'total_amount', 'total_tuition_cost',
  'payment_plan', 'program', 'program_name', 'grade_level', 'homeroom',
  'daily_schedule', 'lead_teacher', 'extended_day', 'extended_day_fee',
  'months_enrolled', 'organic_lunch', 'lunch_fee', 'enrollment_status',
];

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Each active student + their metadata + their enrollments
const studs = (await pool.query(
  `SELECT s.id, s.metadata FROM students s WHERE s.school_id=$1 AND s.status='active'`,
  [SCHOOL_ID],
)).rows;

let stamped = 0, enrollmentsTouched = 0, noEnrollment = 0;
for (const st of studs) {
  const md = st.metadata ?? {};
  const subset = {};
  for (const k of YEAR_KEYS) {
    if (md[k] !== undefined && md[k] !== null && md[k] !== '') subset[k] = md[k];
  }
  if (Object.keys(subset).length === 0) continue;
  const enrs = (await pool.query(
    `SELECT id FROM enrollments WHERE student_id=$1`, [st.id],
  )).rows;
  if (enrs.length === 0) { noEnrollment++; continue; }
  for (const e of enrs) {
    if (APPLY) {
      await pool.query(
        `UPDATE enrollments SET metadata = COALESCE(metadata,'{}'::jsonb) || $2::jsonb, updated_at=now() WHERE id=$1`,
        [e.id, JSON.stringify(subset)],
      );
    }
    enrollmentsTouched++;
  }
  stamped++;
}

console.log(`mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
console.log(`students with year data: ${stamped}/${studs.length}`);
console.log(`${APPLY ? 'stamped' : 'would stamp'} ${enrollmentsTouched} enrollment rows  (students without enrollment: ${noEnrollment})`);

if (APPLY) {
  const sample = await pool.query(
    `SELECT e.academic_year, e.metadata->>'program_tuition' tuition
       FROM enrollments e JOIN students s ON s.id=e.student_id
      WHERE s.school_id=$1 AND s.last_name='Brewer' ORDER BY e.academic_year`, [SCHOOL_ID]);
  console.log('Brewer enrollments now:', JSON.stringify(sample.rows));
} else {
  console.log('\nDRY-RUN — nothing written. Re-run with --apply.');
}
await pool.end();
