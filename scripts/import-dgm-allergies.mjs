// Import DGM 'Allergies & Special Needs 2025-26' into the student
// records + push to the family's GHL contact (per-slot custom fields).
//
// Source data: scripts/data/dgm_allergies_2025_26.json
//   (regenerate via `python scripts/_extract_dgm_allergies.py <xlsx>`
//    when the source workbook changes)
//
// What this writes:
//   1. students.metadata.allergy             ← food allergy text
//      students.metadata.special_instructions← other special notes
//      (preserves all other metadata keys; the FamilyHubTable widget
//      already surfaces `metadata.allergy` via has_allergy flag.)
//   2. student_health_profiles                 ← INSERT or UPDATE
//      .allergies          ← food allergy text
//      .medical_conditions ← special instructions text (additive — appends
//                            with separator so we don't clobber existing notes)
//   3. GHL custom fields on the primary parent's contact:
//      student_<N>_allergy
//      student_<N>_special_instructions     (skipped if no field with
//                                            that key exists in the GHL
//                                            location — staff can add it
//                                            later and re-run.)
//
// Student matching:
//   - Normalize names: strip parens, collapse whitespace
//   - Try preferred_name + last_name, fall back to first_name + last_name
//   - Use the classroom hint (Classroom 4 -> CR4, Tower -> UE Tower, etc.)
//     to disambiguate when names overlap
//
// Idempotent — re-running overwrites the same fields with the same
// values. Pass --dry-run to print what would change without writing.
//
// Usage:
//   node scripts/import-dgm-allergies.mjs
//   node scripts/import-dgm-allergies.mjs --dry-run
//   node scripts/import-dgm-allergies.mjs --no-ghl     # skip GHL writeback
//   node scripts/import-dgm-allergies.mjs --school-id <uuid>

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// ── .env loader ─────────────────────────────────────────────────────
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
const DEFAULT_DGM_SCHOOL_ID = 'cfa9030d-c8fe-49ae-a9e7-f1003844ec07';
const schoolId = args.schoolId || DEFAULT_DGM_SCHOOL_ID;
const dryRun = args.dryRun;
const writeGhl = !args.noGhl && !dryRun;

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Classroom string from the spreadsheet -> our students.metadata.classroom_code
// and students.homeroom conventions. DGM's GHL uses bare "CR1".."CR8",
// "Tower", "MYHS" — but rosters sometimes have "UE Tower" or "LE CR11".
// We try several candidates per source classroom and pick the first
// student row that matches.
const CLASSROOM_ALIASES = {
  'Classroom 1':  ['CR1', 'Primary CR1', '1'],
  'Classroom 2':  ['CR2', 'Primary CR2', '2'],
  'Classroom 3':  ['CR3', 'Primary CR3', '3'],
  'Classroom 4':  ['CR4', 'Primary CR4', '4'],
  'Classroom 5':  ['CR5', 'Primary CR5', '5'],
  'Classroom 6':  ['CR6', 'Primary CR6', '6'],
  'Classroom 7':  ['CR7', 'Primary CR7', '7'],
  'Classroom 8':  ['CR8', 'Primary CR8', '8'],
  'Classroom 10': ['CR10', 'UE CR10', 'Upper Elementary CR10', '10'],
  'Classroom 11': ['CR11', 'LE CR11', 'Lower Elementary CR11', '11'],
  'Classroom 12': ['CR12', 'LE CR12', 'Lower Elementary CR12', '12'],
  'Tower':        ['Tower', 'UE Tower', 'Upper Elementary Tower'],
  'MYHS':         ['MYHS', 'MS', 'HS', 'Middle School', 'High School',
                   'MS 7 & 8', 'HS 9, 10, 11 & 12'],
};

// ─── MAIN ───────────────────────────────────────────────────────────
async function main() {
  console.log(`Mode: ${dryRun ? 'DRY-RUN (no writes)' : 'LIVE'}; GHL writeback: ${writeGhl ? 'ON' : 'OFF'}`);

  const sRes = await pool.query(
    `SELECT id, name, ghl_location_id FROM schools WHERE id = $1`, [schoolId],
  );
  if (sRes.rowCount === 0) {
    console.error(`School ${schoolId} not found.`);
    process.exit(2);
  }
  console.log(`School: ${sRes.rows[0].name} (${schoolId})\n`);

  // Load every active student with the bits we need to match + write to GHL.
  // Note: homeroom lives in students.metadata->>'homeroom' (jsonb), not a column.
  // DGM stores it as "Classroom 4", "Tower", "MYHS" — same shape as the
  // source spreadsheet, so the alias table is mostly a safety net for the
  // few edge cases ("UE Tower", "LE CR11" variants from imports).
  const { rows: students } = await pool.query(
    `SELECT s.id, s.first_name, s.last_name, s.preferred_name,
            (s.metadata->>'homeroom') AS homeroom,
            s.metadata, s.family_id,
            COALESCE(NULLIF(s.metadata->>'slot', '')::int, 1) AS slot,
            (SELECT p.ghl_contact_id FROM parents p
              WHERE p.family_id = s.family_id AND p.is_primary = true
                AND p.ghl_contact_id IS NOT NULL
              ORDER BY p.created_at LIMIT 1) AS primary_parent_ghl_contact_id
       FROM students s
      WHERE s.school_id = $1 AND s.status = 'active'`,
    [schoolId],
  );
  console.log(`Loaded ${students.length} active students from DGM.\n`);

  // Build a flat index for fast name+classroom lookup. Extract any
  // parenthesized aliases from first_name too (DB sometimes stores
  // "Fernando (Leon)" — that's a Leon-Jimenez nickname).
  const index = students.map((s) => ({
    ...s,
    norm_first:           normalizeName(s.first_name),
    norm_preferred:       normalizeName(s.preferred_name),
    norm_first_aliases:   extractAliases(s.first_name),
    norm_last:            normalizeName(s.last_name),
    norm_homeroom:        normalizeRoom(s.homeroom),
  }));

  // Load source data.
  const jsonPath = join(projectRoot, 'scripts/data/dgm_allergies_2025_26.json');
  const source = JSON.parse(readFileSync(jsonPath, 'utf8'));
  console.log(`Source: ${source.length} student-allergy rows\n`);

  // Resolve GHL client + customFields catalog ONCE if writing.
  let ghl = null;
  let fieldIdByKey = new Map();
  if (writeGhl) {
    ghl = await loadGhlClientDirect(schoolId);
    const cf = await ghl.axios.get(`/locations/${ghl.locationId}/customFields`);
    for (const f of cf.data.customFields ?? []) {
      const k = String(f.fieldKey ?? '').replace(/^contact\./, '');
      if (k) fieldIdByKey.set(k, f.id);
    }
    console.log(`GHL: loaded ${fieldIdByKey.size} custom fields for location ${ghl.locationId}\n`);
  }

  let matched = 0, ambiguous = 0, unmatched = 0;
  let dbUpdates = 0, ghlUpdates = 0, ghlSkipped = 0, ghlNoContact = 0;
  const unmatchedRows = [];

  for (const row of source) {
    const candidates = matchStudent(index, row);
    if (candidates.length === 0) {
      unmatched++;
      unmatchedRows.push(row);
      console.log(`  ? unmatched: ${row.name} (${row.classroom})`);
      continue;
    }
    if (candidates.length > 1) {
      ambiguous++;
      console.log(`  ! ambiguous (${candidates.length} matches): ${row.name} (${row.classroom}) -> ${candidates.map((c) => `${c.first_name} ${c.last_name}/${c.homeroom ?? '?'}`).join(', ')}`);
      // Pick the first match anyway — log lets staff review.
    }
    matched++;
    const student = candidates[0];

    if (!dryRun) {
      await writeStudentRecord(student, row);
      dbUpdates++;
    } else {
      console.log(`  + would update ${student.first_name} ${student.last_name} / ${student.homeroom ?? '?'} — allergy="${row.food_allergy.slice(0, 60)}" special="${row.special_instructions.slice(0, 60)}"`);
    }

    if (writeGhl) {
      if (!student.primary_parent_ghl_contact_id) {
        ghlNoContact++;
        continue;
      }
      try {
        const r = await writeStudentHealthToGhl(ghl, student, row, fieldIdByKey);
        if (r.wrote > 0) ghlUpdates++;
        if (r.skipped > 0) ghlSkipped++;
      } catch (e) {
        console.warn(`  ! GHL write failed for ${student.first_name} ${student.last_name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  console.log('');
  console.log(`Matching:    matched=${matched} ambiguous=${ambiguous} unmatched=${unmatched}`);
  console.log(`DB writes:   ${dbUpdates}${dryRun ? ' (would-be — dry-run)' : ''}`);
  if (writeGhl) {
    console.log(`GHL writes:  ${ghlUpdates} contacts updated, ${ghlSkipped} had no matching field, ${ghlNoContact} students had no primary-parent GHL contact`);
  }
  if (unmatchedRows.length > 0) {
    console.log('');
    console.log('Unmatched rows (need DGM follow-up):');
    for (const r of unmatchedRows) {
      console.log(`  - ${r.name} (${r.classroom}) — food="${r.food_allergy.slice(0, 50)}", special="${r.special_instructions.slice(0, 50)}"`);
    }
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => pool.end());

// ─── student lookup helpers ─────────────────────────────────────────

function normalizeName(s) {
  if (!s) return '';
  // Drop parenthesized aliases like "Elliott (Ellie)" -> the alias is
  // extracted separately. Normalize curly quotes, hyphens, apostrophes,
  // then strip everything that isn't a letter/space. We treat hyphen
  // AND apostrophe as a space, so "Ly'ricc Ellis-Williams" in the DB
  // and "Ly-ricc Ellis Williams" in the spreadsheet collapse to the
  // same normalized form.
  return String(s)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[()]/g, ' ')
    .replace(/[-']/g, ' ')
    .replace(/[^a-zA-Z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeRoom(s) {
  if (!s) return '';
  return String(s).trim().toLowerCase();
}

// Extract any "(Alias)" tokens from a name (DB may store these too,
// e.g. "Fernando (Leon)" in first_name).
function extractAliases(s) {
  if (!s) return [];
  const out = [];
  for (const m of String(s).matchAll(/\(([^)]+)\)/g)) {
    const a = normalizeName(m[1]);
    if (a) out.push(a);
  }
  return out;
}

// Levenshtein distance (small inputs — fine to be O(m*n)).
function lev(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  const m = a.length, n = b.length;
  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

// Tokenize a normalized name into words.
function tokens(s) { return s ? s.split(' ').filter(Boolean) : []; }

// Given source name "Aria Valenzuela Barcelo", produce every plausible
// (firstSet, lastSet) split. Multi-word last names + DB sometimes
// reverses the order ("Sicardi Lastra" -> "Lastra Sicardi"), so we
// emit both ordered AND reverse-ordered last-name strings.
function nameSplits(name) {
  const aliases = extractAliases(name);
  const stripped = normalizeName(name);
  const tks = tokens(stripped);
  if (tks.length === 0) return [];
  if (tks.length === 1) return [{ first: tks[0], last: '', aliases }];

  const splits = [];
  for (let k = 1; k < tks.length; k++) {
    const first = tks.slice(0, k).join(' ');
    const lastWords = tks.slice(k);
    splits.push({ first, last: lastWords.join(' '), aliases });
    if (lastWords.length > 1) {
      // Reversed order for "Lastra Sicardi" <-> "Sicardi Lastra"
      splits.push({ first, last: [...lastWords].reverse().join(' '), aliases });
    }
  }
  return splits;
}

function nameMatchesExact(s, first, last, aliases) {
  if (!last) return false;
  if (s.norm_last !== last) return false;
  const studentFirsts = [s.norm_first, s.norm_preferred, ...s.norm_first_aliases].filter(Boolean);
  const sourceFirsts = [first, ...aliases].filter(Boolean);
  for (const sf of studentFirsts) {
    for (const src of sourceFirsts) {
      if (sf === src) return true;
      // First-name prefix on both sides handles "Elliott" <-> "Ellie"
      // when one side is a stem of the other.
      if (sf.length >= 3 && src.length >= 3 && (sf.startsWith(src) || src.startsWith(sf))) return true;
    }
  }
  return false;
}

function matchStudent(index, row) {
  const splits = nameSplits(row.name);
  // Always include the source classroom string itself — DGM rosters
  // often have homeroom='Classroom 1' verbatim, but our alias table
  // only listed 'CR1' / 'Primary CR1' etc.
  const roomCandidates = [
    normalizeRoom(row.classroom),
    ...(CLASSROOM_ALIASES[row.classroom] ?? []).map(normalizeRoom),
  ];
  // Strict: homeroom must match one of our candidates.
  const roomMatchesStrict = (s) =>
    roomCandidates.length === 0 || roomCandidates.includes(s.norm_homeroom);
  // Loose: also accept students with NO homeroom set in the DB. Many
  // Tower/MYHS rows in DGM have homeroom=NULL; without this they'd
  // fail every tier when classroom is given.
  const roomMatchesLoose = (s) =>
    !s.norm_homeroom || roomMatchesStrict(s);

  // Tier 1: any exact split matches + homeroom hint matches
  for (const sp of splits) {
    const hits = index.filter((s) => nameMatchesExact(s, sp.first, sp.last, sp.aliases) && roomMatchesStrict(s));
    if (hits.length > 0) return hits;
  }
  // Tier 2: any exact split, ignore homeroom
  for (const sp of splits) {
    const hits = index.filter((s) => nameMatchesExact(s, sp.first, sp.last, sp.aliases));
    if (hits.length > 0) return hits;
  }

  // Tier 3: last-name match + LOOSE homeroom (allow NULL); first-name
  // may differ entirely. Catches "Rosie King" -> "Rosalyn King",
  // "Manny Sanchez-Gomez" -> "Manuel Sanchez Gomez".
  const lastWordsCandidates = new Set();
  for (const sp of splits) lastWordsCandidates.add(sp.last);
  let hits = index.filter((s) =>
    s.norm_last && lastWordsCandidates.has(s.norm_last) && roomMatchesLoose(s),
  );
  if (hits.length === 1) return hits;
  if (hits.length > 1) {
    // Multiple last-name + classroom matches with different first names —
    // pick the one whose first letter matches the source's first letter.
    const sourceFirstLetter = (normalizeName(row.name).split(' ')[0] ?? '')[0];
    const narrowed = hits.filter((s) => (s.norm_first[0] ?? '') === sourceFirstLetter);
    return narrowed.length > 0 ? narrowed : hits;
  }

  // Tier 4: Levenshtein ≤ 2 on the full normalized name; LOOSE homeroom.
  // Catches typos: "Coronoa" / "Zimbleman" / "Cecellia" / "Danny->Daniel".
  const sourceFull = normalizeName(row.name);
  const ranked = index
    .map((s) => {
      const studentFull = `${s.norm_first} ${s.norm_last}`.trim();
      return { s, d: lev(sourceFull, studentFull) };
    })
    .filter((x) => x.d <= 2 && roomMatchesLoose(x.s))
    .sort((a, b) => a.d - b.d);
  if (ranked.length > 0) return [ranked[0].s];

  return [];
}

// ─── DB write ────────────────────────────────────────────────────────

async function writeStudentRecord(student, row) {
  // Merge into existing metadata so other keys (slot, classroom_code, etc.)
  // are preserved. Use jsonb_set for atomic update.
  const newMeta = { ...(student.metadata ?? {}) };
  if (row.food_allergy) newMeta.allergy = row.food_allergy;
  if (row.special_instructions) newMeta.special_instructions = row.special_instructions;
  await pool.query(
    `UPDATE students SET metadata = $1::jsonb, updated_at = now() WHERE id = $2`,
    [JSON.stringify(newMeta), student.id],
  );

  // student_health_profiles: upsert. allergies + medical_conditions
  // are free-text; we OVERWRITE (this import is authoritative for the
  // 2025-26 year). If staff added extra notes via the parent-form
  // workflow later, they'll need to re-add them — that's documented
  // in the script header.
  await pool.query(
    `INSERT INTO student_health_profiles
       (school_id, student_id, allergies, medical_conditions, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (school_id, student_id) DO UPDATE
       SET allergies          = COALESCE(NULLIF($3, ''), student_health_profiles.allergies),
           medical_conditions = COALESCE(NULLIF($4, ''), student_health_profiles.medical_conditions),
           updated_at         = now()`,
    [schoolId, student.id, row.food_allergy || null, row.special_instructions || null],
  );
}

// ─── GHL writeback ───────────────────────────────────────────────────

async function writeStudentHealthToGhl(ghl, student, row, fieldIdByKey) {
  // Slot pattern: slot 1 = bare "student_<base>"; slot 2-4 = "student_<N>_<base>"
  const slot = student.slot;
  const prefix = slot === 1 ? 'student' : `student_${slot}`;
  const allergyKey = `${prefix}_allergy`;
  const specialKey = `${prefix}_special_instructions`;

  const writes = [];
  const skipped = [];

  if (row.food_allergy) {
    const id = fieldIdByKey.get(allergyKey);
    if (id) writes.push({ id, field_value: row.food_allergy });
    else skipped.push(allergyKey);
  }
  if (row.special_instructions) {
    const id = fieldIdByKey.get(specialKey);
    if (id) writes.push({ id, field_value: row.special_instructions });
    else skipped.push(specialKey);
  }

  if (writes.length === 0) {
    return { wrote: 0, skipped: skipped.length };
  }

  await ghl.axios.put(`/contacts/${student.primary_parent_ghl_contact_id}`, {
    customFields: writes,
  });
  return { wrote: writes.length, skipped: skipped.length };
}

// ─── GHL client (inline so this script has no TS-only deps) ──────────

async function loadGhlClientDirect(sid) {
  const { rows } = await pool.query(
    `SELECT id, ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag
       FROM schools WHERE id = $1`, [sid],
  );
  if (rows.length === 0) throw new Error(`school ${sid} not found`);
  const sch = rows[0];
  const pit = decryptPit(sch);
  const axios = await import('axios');
  const instance = axios.default.create({
    baseURL: 'https://services.leadconnectorhq.com',
    headers: {
      Authorization: `Bearer ${pit}`,
      Version: '2021-07-28',
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    timeout: 30_000,
  });
  return { axios: instance, locationId: sch.ghl_location_id };
}

function decryptPit(sch) {
  // Mirror lib/crypto.ts (AES-256-GCM with key from ENCRYPTION_KEY env).
  const crypto = require('node:crypto');
  const key = Buffer.from(process.env.ENCRYPTION_KEY ?? '', 'base64');
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, sch.ghl_pit_iv);
  decipher.setAuthTag(sch.ghl_pit_tag);
  const dec = Buffer.concat([decipher.update(sch.ghl_pit_encrypted), decipher.final()]);
  return dec.toString('utf8');
}

// ESM doesn't have require by default; shim it.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// ─── args ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { schoolId: null, dryRun: false, noGhl: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--school-id') out.schoolId = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--no-ghl') out.noGhl = true;
  }
  return out;
}
