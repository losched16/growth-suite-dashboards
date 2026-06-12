// One-off: seed a clean kiosk demo on DGM's Demo Family.
//   node --env-file=.env.local scripts/seed-kiosk-demo.mjs
//
// Builds a 3-kid family spanning all three pickup waves, sets a parent
// PIN (indexed via pin_lookup) and a grandparent PIN (pin_lookup left
// NULL so the kiosk's legacy scrypt fallback matches it regardless of
// which PARENT_SESSION_SECRET the deployed app uses — bulletproof for a
// live demo).

import pg from 'pg';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { readFileSync } from 'fs';

const scrypt = promisify(crypto.scrypt);
const SCHOOL_ID = 'cfa9030d-c8fe-49ae-a9e7-f1003844ec07';
const FAMILY_ID = 'cdf70975-b0a4-4f3a-8a34-2858bfffe750';
const PARENT_ID = '1e2145d8-d22f-43a1-87c5-cab6288969df';
const SECRET = readFileSync('C:/Users/thelo/temp_secret.txt', 'utf8').trim();

async function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const buf = await scrypt(pin, salt, 32);
  return `${salt}:${buf.toString('hex')}`;
}
function pinLookup(schoolId, pin) {
  return crypto.createHmac('sha256', Buffer.from(SECRET, 'base64')).update(`${schoolId}:${pin}`).digest('hex');
}

const { Client } = pg;
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

// 1. Family display name
await c.query(`UPDATE families SET display_name = 'Carter Family (DEMO)' WHERE id = $1`, [FAMILY_ID]);

// 2. Parent → Jordan Carter, with PIN 2468
await c.query(
  `UPDATE parents SET first_name = 'Jordan', last_name = 'Carter', pin_hash = $2, pin_lookup = $3, pin_set_at = now() WHERE id = $1`,
  [PARENT_ID, await hashPin('2468'), pinLookup(SCHOOL_ID, '2468')],
);

// 3. Three students across the three pickup waves. Reuse the existing
//    "Demo Student" row as the first; insert two more.
const existing = (await c.query(`SELECT id FROM students WHERE family_id = $1 ORDER BY created_at LIMIT 1`, [FAMILY_ID])).rows[0];
const kids = [
  { name: ['Mia', 'Carter'],  program: '03 Primary' },   // 2:30
  { name: ['Noah', 'Carter'], program: '04 Lower El' },  // 3:15
  { name: ['Ava', 'Carter'],  program: '05 Upper El' },  // 3:30
];

// Update existing row → Mia
await c.query(
  `UPDATE students SET first_name = $2, last_name = $3, status = 'active',
       metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('program', $4::text, 'homeroom', 'Demo Classroom')
   WHERE id = $1`,
  [existing.id, kids[0].name[0], kids[0].name[1], kids[0].program],
);
// Clear any rollup so the demo opens on the check-IN flow. (events
// table is append-only; the demo student has none anyway.)
await c.query(`DELETE FROM daily_attendance WHERE student_id = $1`, [existing.id]);

const studentIds = [existing.id];
for (const k of kids.slice(1)) {
  const r = await c.query(
    `INSERT INTO students (school_id, family_id, first_name, last_name, status, metadata)
     VALUES ($1, $2, $3, $4, 'active', jsonb_build_object('program', $5::text, 'homeroom', 'Demo Classroom'))
     RETURNING id`,
    [SCHOOL_ID, FAMILY_ID, k.name[0], k.name[1], k.program],
  );
  studentIds.push(r.rows[0].id);
}

// 4. Grandparent pickup person "Susan Carter", PIN 1379, pin_lookup
//    intentionally NULL (legacy fallback path = secret-independent).
//    Authorized for ALL kids (no pickup_person_students rows).
await c.query(`DELETE FROM pickup_persons WHERE family_id = $1 AND name = 'Susan Carter (Grandma)'`, [FAMILY_ID]);
await c.query(
  `INSERT INTO pickup_persons (school_id, family_id, added_by_parent_id, name, relationship, active, is_temporary, pin_hash, pin_lookup, pin_set_at)
   VALUES ($1, $2, $3, 'Susan Carter (Grandma)', 'Grandparent', true, false, $4, NULL, now())`,
  [SCHOOL_ID, FAMILY_ID, PARENT_ID, await hashPin('1379')],
);

console.log('Demo seeded.');
console.log('  Family: Carter Family (DEMO) — 3 kids:');
console.log('    Mia Carter   (Primary)    → 2:30 wave');
console.log('    Noah Carter  (Lower El)   → 3:15 wave');
console.log('    Ava Carter   (Upper El)   → 3:30 wave');
console.log('  Parent PIN (Jordan Carter): 2468');
console.log('  Grandparent PIN (Susan Carter): 1379');
console.log('  Student IDs:', studentIds.join(', '));

await c.end();
