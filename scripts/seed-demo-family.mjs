// Seeds a "Demo Family" (1 parent + 1 student) for a given school.
// Idempotent: if the demo family already exists for that school, it
// just resets the password to the deterministic demo value.
//
// USAGE:
//   node scripts/seed-demo-family.mjs                              # defaults to DGM
//   node scripts/seed-demo-family.mjs --location wy1qNRECEgy8lg8pKqm0
//   node scripts/seed-demo-family.mjs --school <school_uuid>
//
// The created family is harmless test data — emails are @growthsuite.test
// (a non-real domain) so no actual messages can be sent to it. Admins can
// log in as the demo parent to see exactly what their families see when
// they fill out enrollment forms, view invoices, etc.
//
// Print at the end gives the operator the email + password to share with
// the demo audience.

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

// Parse args.
const args = process.argv.slice(2);
function arg(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
}
const locationArg = arg('--location');
const schoolArg = arg('--school');

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const buf = await scrypt(plain, salt, 32);
  return `${salt}:${buf.toString('hex')}`;
}

// School-slug → short demo email handle (no special chars).
function emailHandleFor(schoolName) {
  return 'demo+' + schoolName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
}

async function resolveSchool(client) {
  if (schoolArg) {
    const { rows } = await client.query(`SELECT id, name FROM schools WHERE id = $1`, [schoolArg]);
    if (rows.length === 0) throw new Error(`No school with id ${schoolArg}`);
    return rows[0];
  }
  const locationId = locationArg ?? 'wy1qNRECEgy8lg8pKqm0';  // DGM default
  const { rows } = await client.query(
    `SELECT id, name FROM schools WHERE ghl_location_id = $1`, [locationId],
  );
  if (rows.length === 0) throw new Error(`No school with location_id ${locationId}`);
  return rows[0];
}

async function main() {
  const c = await pool.connect();
  try {
    const school = await resolveSchool(c);
    const handle = emailHandleFor(school.name);
    const email = `${handle}@growthsuite.test`;
    const password = `demo-${new Date().getFullYear()}`;
    const passwordHash = await hashPassword(password);

    console.log(`Target school: ${school.name} (${school.id})`);
    console.log(`Demo email:    ${email}`);

    // Look up existing demo parent on this school by the magic email.
    const { rows: existing } = await c.query(
      `SELECT p.id AS parent_id, p.family_id
         FROM parents p
        WHERE LOWER(p.email) = LOWER($1) AND p.school_id = $2 AND p.status = 'active'`,
      [email, school.id],
    );

    if (existing.length > 0) {
      // Just reset the password. Don't dup the family/student.
      await c.query(
        `UPDATE parents SET password_hash = $1, password_set_at = now(), updated_at = now() WHERE id = $2`,
        [passwordHash, existing[0].parent_id],
      );
      console.log(`✓ Existing demo parent found — password reset.\n`);
      printCreds({ email, password, schoolName: school.name });
      return;
    }

    // Create fresh: family → parent → student.
    await c.query('BEGIN');
    const { rows: fam } = await c.query(
      `INSERT INTO families (school_id, display_name, status, notes)
       VALUES ($1, $2, 'active', $3)
       RETURNING id`,
      [
        school.id,
        'Demo Family',
        'Auto-created by seed-demo-family.mjs — safe to delete after demos.',
      ],
    );
    const familyId = fam[0].id;

    const { rows: par } = await c.query(
      `INSERT INTO parents (family_id, school_id, first_name, last_name, email, role, is_primary, status, password_hash, password_set_at)
       VALUES ($1, $2, 'Demo', 'Parent', $3, 'parent', true, 'active', $4, now())
       RETURNING id`,
      [familyId, school.id, email, passwordHash],
    );
    const parentId = par[0].id;

    // Pick a student DOB ~ 5 years ago (preschool-ish).
    const dobYear = new Date().getFullYear() - 5;
    const dob = `${dobYear}-09-01`;
    const { rows: stu } = await c.query(
      `INSERT INTO students (family_id, school_id, first_name, last_name, preferred_name, date_of_birth, status, notes)
       VALUES ($1, $2, 'Demo', 'Student', 'Demo Kid', $3, 'active', 'Auto-created demo student.')
       RETURNING id`,
      [familyId, school.id, dob],
    );
    const studentId = stu[0].id;

    await c.query('COMMIT');
    console.log(`✓ Created Demo Family.`);
    console.log(`  family_id  = ${familyId}`);
    console.log(`  parent_id  = ${parentId}`);
    console.log(`  student_id = ${studentId}\n`);
    printCreds({ email, password, schoolName: school.name });
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
    await pool.end();
  }
}

function printCreds({ email, password, schoolName }) {
  const box = (label, value) => console.log(`  ${label.padEnd(10)} ${value}`);
  console.log('═'.repeat(60));
  console.log(`  DEMO PARENT CREDENTIALS — ${schoolName}`);
  console.log('═'.repeat(60));
  box('URL', 'https://growth-suite-parent-portal.vercel.app/login');
  box('Email', email);
  box('Password', password);
  console.log('═'.repeat(60));
  console.log('  Anyone can log in with these. Submissions are real DB');
  console.log('  rows under "Demo Family" so they\'re easy to spot + delete.');
  console.log('═'.repeat(60));
}

main().catch((e) => { console.error(e); process.exit(1); });
