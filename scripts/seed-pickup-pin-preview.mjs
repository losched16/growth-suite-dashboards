// Seeds a pickup person with a known PIN for the kiosk demo,
// plus checks in a student so the kiosk has someone to sign out.
//
// Usage:
//   SCHOOL_ID=<uuid> FAMILY_ID=<uuid> node scripts/seed-pickup-pin-preview.mjs
//
// Demo PIN: 246810 (hardcoded for the demo so it's repeatable and you
// don't have to look it up). In production, parents generate random
// PINs from the parent portal.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
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

const scrypt = promisify(crypto.scrypt);

const SCHOOL_ID = process.env.SCHOOL_ID || '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
const FAMILY_ID = process.env.FAMILY_ID;
const DEMO_PIN = '246810';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const buf = await scrypt(pin, salt, 32);
  return `${salt}:${buf.toString('hex')}`;
}

async function main() {
  const c = await pool.connect();
  try {
    // Resolve demo family
    let familyId = FAMILY_ID;
    if (!familyId) {
      const { rows } = await c.query(
        `SELECT f.id FROM families f
           JOIN students s ON s.family_id = f.id AND s.status = 'active'
          WHERE f.school_id = $1
          GROUP BY f.id
          ORDER BY COUNT(s.id) DESC
          LIMIT 1`,
        [SCHOOL_ID],
      );
      if (rows.length === 0) throw new Error(`No active families with students at school ${SCHOOL_ID}`);
      familyId = rows[0].id;
    }

    // Pick the primary parent of this family — pickup_persons.added_by_parent_id
    const { rows: parents } = await c.query(
      `SELECT id FROM parents
        WHERE family_id = $1 AND school_id = $2 AND status = 'active'
        ORDER BY is_primary DESC, created_at ASC
        LIMIT 1`,
      [familyId, SCHOOL_ID],
    );
    if (parents.length === 0) throw new Error('Demo family has no active parents');
    const parentId = parents[0].id;

    // Pick a student in the family
    const { rows: students } = await c.query(
      `SELECT id,
              CONCAT_WS(' ', COALESCE(NULLIF(preferred_name, ''), first_name), last_name) AS name
         FROM students
        WHERE family_id = $1 AND school_id = $2 AND status = 'active'
        ORDER BY first_name ASC
        LIMIT 1`,
      [familyId, SCHOOL_ID],
    );
    if (students.length === 0) throw new Error('Demo family has no active students');
    const student = students[0];

    // 1) Upsert Grandma Sue with the demo PIN (idempotent — match by name)
    const pinHash = await hashPin(DEMO_PIN);
    await c.query(
      `DELETE FROM pickup_persons
        WHERE school_id = $1
          AND added_by_parent_id = $2
          AND name = 'Grandma Sue (demo)'`,
      [SCHOOL_ID, parentId],
    );
    await c.query(
      `INSERT INTO pickup_persons
         (school_id, added_by_parent_id, name, relationship, phone, notes,
          active, pin_hash, pin_set_at, pin_expires_at, is_temporary)
       VALUES ($1, $2, 'Grandma Sue (demo)', 'Grandmother', '480-555-0101',
               'Demo pickup person. Walks Margaret to the car.',
               true, $3, now(), NULL, false)`,
      [SCHOOL_ID, parentId, pinHash],
    );
    console.log(`✓ Seeded "Grandma Sue (demo)" with PIN ${DEMO_PIN} for parent ${parentId}.`);

    // 2) Ensure the demo student is checked in today (so the kiosk has
    //    someone to pick up). If they're already in daily_attendance,
    //    leave it alone — the trigger that maintains daily_attendance
    //    will re-roll if needed.
    await c.query(
      `INSERT INTO attendance_events
         (school_id, student_id, event_type, performed_by_admin_email)
       VALUES ($1, $2, 'check_in', 'preview-seed@growthsuite.local')`,
      [SCHOOL_ID, student.id],
    );
    console.log(`✓ Checked in ${student.name} (today) so the kiosk has someone to sign out.`);

    console.log('\n──────────────────────────────────────────────────────────');
    console.log(`Kiosk URL:`);
    console.log(`  /kiosk/${SCHOOL_ID}/pickup`);
    console.log(`Demo PIN: ${DEMO_PIN}`);
    console.log(`Authorized for: ${student.name} (and other students in the family)`);
    console.log('──────────────────────────────────────────────────────────\n');
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
