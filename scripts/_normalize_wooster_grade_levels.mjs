// One-off: collapse the mishmash of grade_level labels on Wooster
// students into a single canonical format.
//
// Two sources currently fight each other:
//   1. The Final Forms import wrote labels like "8th Grade (Middle
//      School)" with my own helper. That helper also grouped 1-5 as
//      generic "Elementary" — wrong for Wooster, which splits 1-3
//      (Lower Elementary) from 4-6 (Upper Elementary).
//   2. The earlier GHL-derived backfill stored values like "Eighth
//      Grader - Middle School", "Second Year Preschool - Oldtimer",
//      "First Year Toddler" — the literal dropdown labels Wooster
//      uses inside GHL.
//
// This script re-derives grade_level from SOURCES, not from the
// stored value (which may already be corrupted by an earlier
// botched normalization pass):
//   - If students.metadata.grade is a number (Final Forms import) →
//     use that
//   - Otherwise, refetch the GHL contact's what_is_your_childs_current_level
//     field for the primary parent
//   - Map either signal to one canonical label using Wooster's actual
//     Montessori groupings (1-3 = Lower Elementary, 4-6 = Upper,
//     7-8 = Middle School, 9-12 = High School)

import pg from 'pg';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

const env = readFileSync('.env.local', 'utf8');
const lines = Object.fromEntries(
  env.split('\n').filter((l) => l.includes('=')).map((l) => {
    const i = l.indexOf('=');
    return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
  }),
);
const dbUrl = lines.DATABASE_URL;
const encKey = lines.ENCRYPTION_KEY;

function decrypt(ciphertext, iv, tag) {
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(encKey, 'base64'), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ciphertext, 'base64')), d.final()]).toString('utf8');
}

const c = new pg.Client({ connectionString: dbUrl });
await c.connect();

const sc = (await c.query(
  `SELECT id, ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag
     FROM schools WHERE name ILIKE '%wooster%' LIMIT 1`,
)).rows[0];
const woosterId = sc.id;
const pit = decrypt(sc.ghl_pit_encrypted, sc.ghl_pit_iv, sc.ghl_pit_tag);
const locationId = sc.ghl_location_id;

function ordinal(n) {
  if (n >= 11 && n <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

function canonical(n) {
  if (n == null) return null;
  if (n <= -3) return 'Toddler (under 3)';
  if (n === -2) return 'Preschool (3 yr)';
  if (n === -1) return 'Pre-K (4 yr)';
  if (n === 0)  return 'Kindergarten';
  if (n >= 1 && n <= 3) return `${ordinal(n)} Grade (Lower Elementary)`;
  if (n >= 4 && n <= 6) return `${ordinal(n)} Grade (Upper Elementary)`;
  if (n >= 7 && n <= 8) return `${ordinal(n)} Grade (Middle School)`;
  if (n >= 9 && n <= 12) return `${ordinal(n)} Grade (High School)`;
  return `Grade ${n}`;
}

function rawToGrade(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim().toLowerCase();
  const direct = Number(s);
  if (Number.isFinite(direct) && /^-?\d+$/.test(s)) return direct;

  // Pre-K / preschool / toddler / kindergarten markers WIN over the
  // ordinal-word match below. "First Year Toddler" → toddler, not 1st.
  if (s.includes('infant') || s.includes('under 18 months')) return -3;
  if (s.includes('toddler')) return -3;
  if (s.includes('preschool') || s.includes('newtimers') || s.includes('oldtimer')) return -2;
  if (s.includes('pre-k') || s.includes('young kdg') || s.includes('will be kdg')) return -1;
  if (s.includes('kindergarten') || s.includes('kdg')) return 0;

  const words = {
    'first': 1, 'second': 2, 'third': 3, 'fourth': 4, 'fifth': 5,
    'sixth': 6, 'seventh': 7, 'eighth': 8, 'ninth': 9, 'tenth': 10,
    'eleventh': 11, 'twelfth': 12,
  };
  for (const [word, n] of Object.entries(words)) {
    const re = new RegExp(`^${word}\\b\\s+(grade|grader)`);
    if (re.test(s)) return n;
  }

  // "1st Grade (...)" canonical / Final Forms style
  const m = s.match(/^(\d+)(st|nd|rd|th)\s+grade/);
  if (m) return Number(m[1]);

  return null;
}

// ─── Step 1: pull fresh GHL grade-level for slot-1 students whose
// metadata.grade isn't a number we can trust. ────────────────────────

// Find the GHL field id for what_is_your_childs_current_level
const cfRes = await fetch(`https://services.leadconnectorhq.com/locations/${locationId}/customFields`, {
  headers: { Authorization: `Bearer ${pit}`, Version: '2021-07-28', Accept: 'application/json' },
});
const cfData = await cfRes.json();
const fieldId = (cfData.customFields ?? []).find((f) => f.fieldKey === 'contact.what_is_your_childs_current_level')?.id;
if (!fieldId) throw new Error('current-level field not found in GHL schema');

// All slot-1 students whose Final-Forms numeric grade is missing/blank.
// We need to pull from GHL to get the authoritative current-level value
// (and reset any wrong label written by an earlier botched normalization).
const fallbackSlot1 = (await c.query(
  `SELECT s.id AS student_id,
          s.metadata,
          (SELECT p.ghl_contact_id FROM parents p
            WHERE p.family_id = s.family_id AND p.is_primary = true
            LIMIT 1) AS ghl_contact_id
     FROM students s
    WHERE s.school_id = $1 AND s.status = 'active'
      AND COALESCE((s.metadata->>'slot')::int, 1) = 1
      AND (s.metadata->>'grade' IS NULL
           OR s.metadata->>'grade' = ''
           OR s.metadata->>'grade' !~ '^-?[0-9]+$')`,
  [woosterId],
)).rows;
console.log(`${fallbackSlot1.length} slot-1 students need a GHL fallback pull`);

const ghlGradeByStudent = new Map();
for (const r of fallbackSlot1) {
  if (!r.ghl_contact_id) continue;
  try {
    const got = await fetch(`https://services.leadconnectorhq.com/contacts/${r.ghl_contact_id}`, {
      headers: { Authorization: `Bearer ${pit}`, Version: '2021-07-28', Accept: 'application/json' },
    });
    if (!got.ok) continue;
    const data = await got.json();
    const cf = (data.contact?.customFields ?? []).find((x) => x.id === fieldId);
    if (cf?.value) ghlGradeByStudent.set(r.student_id, cf.value);
  } catch { /* ignore one-off failures */ }
}
console.log(`got fresh GHL current-level for ${ghlGradeByStudent.size} of those`);

// ─── Step 2: compute canonical label for each student ──────────────

const { rows: all } = await c.query(
  `SELECT id, metadata FROM students WHERE school_id = $1 AND status = 'active'`,
  [woosterId],
);

const tally = { unchanged: 0, normalized: 0, blank: 0 };
const changes = new Map();

for (const r of all) {
  const md = r.metadata ?? {};
  let n = null;

  // Source 1: Final Forms numeric grade
  const numStr = md.grade;
  if (numStr != null && /^-?\d+$/.test(String(numStr))) {
    n = Number(numStr);
  }
  // Source 2: fresh GHL current-level pull
  if (n == null) {
    const ghl = ghlGradeByStudent.get(r.id);
    if (ghl) n = rawToGrade(ghl);
  }
  // Source 3 (last resort): the currently-stored grade_level text. This
  // also covers students who already have a clean canonical label.
  if (n == null && md.grade_level) {
    n = rawToGrade(md.grade_level);
  }

  const target = canonical(n);
  if (!target) {
    tally.blank++;
    // Wipe any existing stale value so we don't keep showing the
    // pre-fix wrong label.
    if (md.grade_level != null && md.grade_level !== '') {
      changes.set(r.id, { from: md.grade_level, to: null });
    }
    continue;
  }
  if (target === md.grade_level) { tally.unchanged++; continue; }
  changes.set(r.id, { from: md.grade_level, to: target });
}

console.log(`scanned ${all.length} students:`);
console.log(`  ${tally.unchanged} already canonical`);
console.log(`  ${changes.size} need normalization`);
console.log(`  ${tally.blank} have no grade info`);

if (changes.size > 0) {
  console.log('\nsample transforms:');
  for (const [, ch] of [...changes].slice(0, 20)) {
    console.log(`  "${ch.from ?? '(null)'}" → "${ch.to ?? '(null)'}"`);
  }

  await c.query('BEGIN');
  for (const [id, ch] of changes) {
    if (ch.to == null) {
      await c.query(
        `UPDATE students
            SET metadata = metadata - 'grade_level',
                updated_at = now()
          WHERE id = $1`,
        [id],
      );
    } else {
      await c.query(
        `UPDATE students
            SET metadata = jsonb_set(metadata, '{grade_level}', to_jsonb($1::text)),
                updated_at = now()
          WHERE id = $2`,
        [ch.to, id],
      );
    }
  }
  await c.query('COMMIT');
  console.log(`\ncommitted ${changes.size} updates`);
}

console.log('\n--- final grade_level distribution ---');
const after = await c.query(`
  SELECT s.metadata->>'grade_level' AS grade_level, count(*) n
    FROM students s WHERE s.school_id = $1 AND s.status = 'active'
   GROUP BY grade_level ORDER BY n DESC
`, [woosterId]);
for (const r of after.rows) console.log(`  ${(r.grade_level ?? '(null)').padEnd(40)} ${r.n}`);

await c.end();
