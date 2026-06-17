// Tag MCH's kindergarten students and point the Kindergarten-only forms
// (Dental Exam + Act 90) at them.
//
// Per the school's Form Distribution matrix, Dental + Act 90 go to
// kindergarten students only. MCH's data has no kindergarten program/
// grid (K is the oldest year of the Primary classroom), so the school
// hands us the K roster directly — same pattern as the Child Health
// Report's 42-student list.
//
// We set applies_to = { student_ids: [...] } on both forms. student_ids
// lives on the form definition, so it is NOT churned by the nightly GHL
// sync that rebuilds students.metadata (a metadata.grade_level flag
// would be). We ALSO stamp metadata.grade_level='kindergarten' for
// display in the Family Hub — informational only, not the targeting
// mechanism.
//
// Usage:
//   node scripts/set-mch-kindergarten-forms.mjs            # DRY RUN
//   node scripts/set-mch-kindergarten-forms.mjs --apply

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
const FORM_SLUGS = ['mch-dental-exam', 'mch-act-90-textbook-request'];

const NAMES = [
  'Bailey, Thea', 'DiPasquale, Elynn', 'Kalasunas, Gytha', 'Marlowe, Rory',
  'Mishra, Prayan', 'Osuwa, Bella', 'Pirrocco, Maya', 'Quintans, Alina',
  'Sekel, Violet', 'Sobotta, Ryan', 'Yang, Alicia',
];

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z]/g, '');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  const { rows: students } = await pool.query(
    `SELECT id, first_name, last_name, metadata->>'preferred_name' AS preferred_name
       FROM students WHERE school_id = $1 AND status = 'active'`,
    [SCHOOL],
  );
  const byKey = new Map();
  for (const s of students) {
    const last = norm(s.last_name);
    byKey.set(`${norm(s.first_name)}|${last}`, s);
    if (s.preferred_name) byKey.set(`${norm(s.preferred_name)}|${last}`, s);
  }

  const matchedIds = []; const matchedNames = []; const unmatched = [];
  for (const name of NAMES) {
    const [lastRaw, firstRaw] = name.split(',').map((x) => x.trim());
    const s = byKey.get(`${norm(firstRaw)}|${norm(lastRaw)}`);
    if (s) { matchedIds.push(s.id); matchedNames.push(`${name} → ${s.first_name} ${s.last_name}`); }
    else unmatched.push(name);
  }

  console.log(`=== MATCHED ${matchedIds.length}/${NAMES.length} ===`);
  for (const m of matchedNames) console.log('  ✓ ' + m);
  if (unmatched.length) { console.log('\n=== UNMATCHED ==='); for (const u of unmatched) console.log('  ✗ ' + u); }

  if (!APPLY) { console.log('\nDRY RUN — re-run with --apply.'); await pool.end(); return; }
  if (unmatched.length) { console.log('\nABORT: resolve unmatched names first.'); await pool.end(); process.exit(1); }

  const rule = JSON.stringify({ student_ids: matchedIds });
  for (const slug of FORM_SLUGS) {
    const r = await pool.query(
      `UPDATE portal_form_definitions SET applies_to = $3::jsonb, updated_at = now()
        WHERE school_id = $1 AND slug = $2 RETURNING id`,
      [SCHOOL, slug, rule],
    );
    console.log(`  ✓ ${slug}: applies_to set to ${matchedIds.length} kindergarten student_ids (${r.rowCount} updated)`);
  }
  // Informational grade_level stamp (not the targeting mechanism).
  const g = await pool.query(
    `UPDATE students SET metadata = COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('grade_level','kindergarten'), updated_at = now()
      WHERE id = ANY($1::uuid[]) RETURNING id`,
    [matchedIds],
  );
  console.log(`  ✓ stamped grade_level='kindergarten' on ${g.rowCount} students`);
  console.log('\nDone.');
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
