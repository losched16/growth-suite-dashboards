// Merge two student records that represent the same kid.
//
// Crystal Woody's family has two rows for "Benson Nethers" — one for
// slot 1 (preferred name "Benny", rich Final Forms data) and one for
// slot 2 (sync-created stub). They're the same child; GHL stored him
// in both student slots. We keep the rich slot-1 record and re-point
// every foreign-key reference at it before deleting the stub.
//
// Reusable for any future "two student rows, same kid" situation —
// pass `KEEP_ID` and `DROP_ID` env vars (or edit the constants below).
// Idempotent if you re-run after a successful merge (DROP_ID won't
// exist).

import pg from 'pg';
import { readFileSync } from 'node:fs';

const env = readFileSync('.env.local', 'utf8');
const dbUrl = env.match(/^DATABASE_URL=(.*)$/m)?.[1]?.trim();
const c = new pg.Client({ connectionString: dbUrl });
await c.connect();

const KEEP_ID = process.env.KEEP_ID || '2dcf02db-1130-43bd-9de2-7dca2759b5e7';  // Benny (slot 1, full Final Forms data)
const DROP_ID = process.env.DROP_ID || '5c4e26e2-dfae-4037-8116-0ff778fe1529';  // Slot 2 stub
const DRY_RUN = process.argv.includes('--dry-run');
if (DRY_RUN) console.log('[DRY RUN] no writes will be made');

console.log(`merging ${DROP_ID} → ${KEEP_ID}`);

// Sanity: both rows must belong to the same family and school
const both = await c.query(
  `SELECT id, family_id, school_id, first_name, last_name, preferred_name
     FROM students WHERE id = ANY($1::uuid[])`,
  [[KEEP_ID, DROP_ID]],
);
if (both.rows.length === 1 && both.rows[0].id === KEEP_ID) {
  console.log('DROP_ID does not exist — already merged. Nothing to do.');
  await c.end();
  process.exit(0);
}
if (both.rows.length !== 2) throw new Error(`expected to find both students; got ${both.rows.length}`);
const [a, b] = both.rows;
if (a.family_id !== b.family_id) throw new Error('students belong to different families — refusing to merge');
if (a.school_id !== b.school_id) throw new Error('students belong to different schools — refusing to merge');

// Always run inside a transaction so dry-run rolls back at the end
// instead of relying on Postgres autocommit (the original bug — dry
// run silently committed Crystal's merge).
await c.query('BEGIN');

try {
  // ─── 1. Re-link FKs that should follow the kept student ──────────────
  // portal_form_submissions: keep them all (they're history). The keeper
  // student will end up with a few more submissions, but the system
  // already tolerates multiple per form per student.
  const fs = await c.query(
    `UPDATE portal_form_submissions SET student_id = $1 WHERE student_id = $2`,
    [KEEP_ID, DROP_ID],
  );
  console.log(`  portal_form_submissions re-linked: ${fs.rowCount}`);

  const ai = await c.query(
    `UPDATE attendance_events SET student_id = $1 WHERE student_id = $2`,
    [KEEP_ID, DROP_ID],
  );
  console.log(`  attendance_events re-linked: ${ai.rowCount}`);

  const da = await c.query(
    `UPDATE daily_attendance SET student_id = $1 WHERE student_id = $2`,
    [KEEP_ID, DROP_ID],
  );
  console.log(`  daily_attendance re-linked: ${da.rowCount}`);

  const ei = await c.query(
    `UPDATE enrollment_invites SET student_id = $1 WHERE student_id = $2`,
    [KEEP_ID, DROP_ID],
  );
  console.log(`  enrollment_invites re-linked: ${ei.rowCount}`);

  const fas = await c.query(
    `UPDATE fa_application_students SET student_id = $1 WHERE student_id = $2`,
    [KEEP_ID, DROP_ID],
  );
  console.log(`  fa_application_students re-linked: ${fas.rowCount}`);

  const fap = await c.query(
    `UPDATE fa_applications SET student_id = $1 WHERE student_id = $2`,
    [KEEP_ID, DROP_ID],
  );
  console.log(`  fa_applications re-linked: ${fap.rowCount}`);

  const fb = await c.query(
    `UPDATE facts_balances SET matched_student_id = $1 WHERE matched_student_id = $2`,
    [KEEP_ID, DROP_ID],
  );
  console.log(`  facts_balances re-linked: ${fb.rowCount}`);

  const fst = await c.query(
    `UPDATE facts_students SET matched_student_id = $1 WHERE matched_student_id = $2`,
    [KEEP_ID, DROP_ID],
  );
  console.log(`  facts_students re-linked: ${fst.rowCount}`);

  const fre = await c.query(
    `UPDATE family_relationships SET to_student_id = $1 WHERE to_student_id = $2`,
    [KEEP_ID, DROP_ID],
  );
  console.log(`  family_relationships re-linked: ${fre.rowCount}`);

  const fte = await c.query(
    `UPDATE family_tuition_enrollments SET student_id = $1 WHERE student_id = $2`,
    [KEEP_ID, DROP_ID],
  );
  console.log(`  family_tuition_enrollments re-linked: ${fte.rowCount}`);

  const ili = await c.query(
    `UPDATE invoice_line_items SET student_id = $1 WHERE student_id = $2`,
    [KEEP_ID, DROP_ID],
  );
  console.log(`  invoice_line_items re-linked: ${ili.rowCount}`);

  const iv = await c.query(
    `UPDATE invoices SET student_id = $1 WHERE student_id = $2`,
    [KEEP_ID, DROP_ID],
  );
  console.log(`  invoices re-linked: ${iv.rowCount}`);

  const pu = await c.query(
    `UPDATE parent_uploads SET student_id = $1 WHERE student_id = $2`,
    [KEEP_ID, DROP_ID],
  );
  console.log(`  parent_uploads re-linked: ${pu.rowCount}`);

  const pmf = await c.query(
    `UPDATE portal_migration_flags SET student_id = $1 WHERE student_id = $2`,
    [KEEP_ID, DROP_ID],
  );
  console.log(`  portal_migration_flags re-linked: ${pmf.rowCount}`);

  const sd = await c.query(
    `UPDATE student_documents SET student_id = $1 WHERE student_id = $2`,
    [KEEP_ID, DROP_ID],
  );
  console.log(`  student_documents re-linked: ${sd.rowCount}`);

  const spr = await c.query(
    `UPDATE student_pickup_restrictions SET student_id = $1 WHERE student_id = $2`,
    [KEEP_ID, DROP_ID],
  );
  console.log(`  student_pickup_restrictions re-linked: ${spr.rowCount}`);

  // ─── 2. Resolve UNIQUE-constraint conflicts before re-link or delete ──
  // student_health_profiles has UNIQUE(school_id, student_id). If both
  // rows already have a profile, we keep the keeper's and drop the
  // dropper's. The keeper's profile already exists, so just delete.
  const hp = await c.query(`DELETE FROM student_health_profiles WHERE student_id = $1`, [DROP_ID]);
  console.log(`  student_health_profiles (dropper) deleted: ${hp.rowCount}`);

  // enrollments: the dropper has its own enrollment row. We delete it
  // rather than re-link because the keeper already has the canonical
  // 2026-27 enrollment with full Final Forms metadata.
  const en = await c.query(`DELETE FROM enrollments WHERE student_id = $1`, [DROP_ID]);
  console.log(`  enrollments (dropper) deleted: ${en.rowCount}`);

  // ─── 3. Delete the duplicate student row ─────────────────────────────
  const del = await c.query(`DELETE FROM students WHERE id = $1`, [DROP_ID]);
  console.log(`  students deleted: ${del.rowCount}`);

  if (DRY_RUN) {
    await c.query('ROLLBACK');
    console.log('\n[DRY RUN] rolled back — no changes persisted.');
  } else {
    await c.query('COMMIT');
    console.log('\nMerge complete.');
  }
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  throw e;
} finally {
  await c.end();
}
