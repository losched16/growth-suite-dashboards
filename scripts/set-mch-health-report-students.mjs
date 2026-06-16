// Restrict the MCH Child Health Report (CD-51) to a hand-picked list of
// students the school says need it. Sets
// portal_form_definitions.applies_to = { student_ids: [...] } so the
// parent portal only shows the form to those students.
//
// Usage:
//   node scripts/set-mch-health-report-students.mjs            # DRY RUN — match + report only
//   node scripts/set-mch-health-report-students.mjs --apply    # write the rule

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(join(__dirname, '..', '.env.local'), 'utf8');
for (const line of envText.split('\n')) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('='); if (eq === -1) continue;
  const k = t.slice(0, eq).trim(); if (!process.env[k]) process.env[k] = t.slice(eq + 1).trim();
}

const APPLY = process.argv.includes('--apply');
const SCHOOL = 'a6c4b2dd-050c-4bf9-893b-67106f0f20e8';
const SLUG = 'mch-child-health-report';

// School-provided list — "Last, First".
const NAMES = [
  'Aktug, Aziz', 'Alizai, Zara', 'Allen, Ava', 'Arthur, Madison', 'Beck, Stevie',
  'Brezicha, Maria', 'Canosa, Antonella', 'Colon, Marcellus', 'DeVaughn, Maxwell',
  'Egbert, Adam', 'Farber, Lara', 'Green, Kanan', 'Kalasunas, Gytha', 'Kelbaugh, Scarlett',
  'King, Charlie', 'Koreniowski, Madison', 'Koreniowski, Natalie', 'Layaou, Alexander',
  'Lewis, Daphne', 'Lewis, Jacqueline', 'Maxwell, Molly', 'Mishra, Prayan', 'Nealis, Penelope',
  "O'Brien, Matilda", 'Osuwa, Bella', 'Piotti, Tatum', 'Pirrocco, Maya', 'Quintans, Alina',
  'Quintans, Siena', 'Sekel, Violet', 'Shrawan, Upeksh', 'Sobotta, Abigail', 'Sobotta, Ryan',
  'Skulski, Niko', 'Suthar, Vlhaan', 'Tryens, Vivienne', 'Ware, Finnley', 'Williams, Blake',
  'Zakorchemny, Michael', 'Waite, Garhett', 'Soulas, William', 'Della-Rocca, Etta',
];

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z]/g, '');

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  const { rows: students } = await pool.query(
    `SELECT id, first_name, last_name, metadata->>'preferred_name' AS preferred_name
       FROM students WHERE school_id = $1 AND status = 'active'`,
    [SCHOOL],
  );

  // Index students by normalized (first|last) and (preferred|last).
  const byKey = new Map();
  for (const s of students) {
    const last = norm(s.last_name);
    byKey.set(`${norm(s.first_name)}|${last}`, s);
    if (s.preferred_name) byKey.set(`${norm(s.preferred_name)}|${last}`, s);
  }
  // Fallback index by first-name only → list of students (for fuzzy last match).
  const byFirst = new Map();
  for (const s of students) {
    const f = norm(s.first_name);
    (byFirst.get(f) ?? byFirst.set(f, []).get(f)).push(s);
  }

  const matchedIds = new Set();
  const matchedNames = [];
  const unmatched = [];

  for (const name of NAMES) {
    const [lastRaw, firstRaw] = name.split(',').map((x) => x.trim());
    const key = `${norm(firstRaw)}|${norm(lastRaw)}`;
    let s = byKey.get(key);
    // Fuzzy fallback: unique student with same first name whose last name
    // is a near-variant (one differs only by inserted/removed letters,
    // e.g. Koreniowski vs Korzeniowski).
    if (!s) {
      const cands = byFirst.get(norm(firstRaw)) ?? [];
      const near = cands.filter((c) => {
        const a = norm(c.last_name), b = norm(lastRaw);
        return a.includes(b) || b.includes(a) || levClose(a, b);
      });
      if (near.length === 1) s = near[0];
    }
    if (s) {
      matchedIds.add(s.id);
      matchedNames.push(`${name}  →  ${s.first_name} ${s.last_name}${norm(s.last_name) !== norm(lastRaw) ? '  [fuzzy]' : ''}`);
    } else {
      unmatched.push(name);
    }
  }

  // MCH students NOT in the list = the "others" who will NOT see the form.
  const excluded = students
    .filter((s) => !matchedIds.has(s.id))
    .map((s) => `${s.last_name}, ${s.first_name}`)
    .sort();

  console.log(`=== MATCHED ${matchedIds.size}/${NAMES.length} ===`);
  for (const m of matchedNames) console.log('  ✓ ' + m);
  console.log(`\n=== UNMATCHED (${unmatched.length}) — fix these before applying ===`);
  for (const u of unmatched) console.log('  ✗ ' + u);
  console.log(`\n=== WILL NOT SEE THE FORM (${excluded.length} other active students) ===`);
  for (const e of excluded) console.log('  · ' + e);

  if (!APPLY) {
    console.log('\nDRY RUN — no changes written. Re-run with --apply once matches look right.');
    await pool.end();
    return;
  }
  if (unmatched.length > 0) {
    console.log('\nABORTING --apply: resolve unmatched names first (otherwise those students would silently NOT get the form).');
    await pool.end();
    process.exit(1);
  }

  const rule = JSON.stringify({ student_ids: [...matchedIds] });
  const r = await pool.query(
    `UPDATE portal_form_definitions SET applies_to = $3::jsonb, updated_at = now()
      WHERE school_id = $1 AND slug = $2 RETURNING id`,
    [SCHOOL, SLUG, rule],
  );
  console.log(`\n✓ APPLIED — ${SLUG}.applies_to set to ${matchedIds.size} student_ids (${r.rowCount} form updated).`);
  await pool.end();
}

// Cheap "differ by a single edit" check for short-ish strings.
function levClose(a, b) {
  if (Math.abs(a.length - b.length) > 2) return false;
  let edits = 0, i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    edits++; if (edits > 2) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  edits += (a.length - i) + (b.length - j);
  return edits <= 2;
}

main().catch((e) => { console.error(e); process.exit(1); });
