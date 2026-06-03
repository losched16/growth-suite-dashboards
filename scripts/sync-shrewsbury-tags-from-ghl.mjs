// Sync Shrewsbury Montessori contact tags from GHL into students.metadata.
//
// Why this exists:
//   Shrewsbury uses tags in GHL to track re-enrollment ("re-enrolled"),
//   classroom assignment ("room 1", "room b", …), and program/age band
//   ("toddler (18 months+) full day", "children's house 3 …", "1st grade",
//   …). The family-graph sync that brought their roster over from the
//   admissions pipeline doesn't pick those up — this script adds the
//   missing layer.
//
// What it writes to students.metadata:
//   tags          string[]  - every tag we found on the parent contact (lowercased)
//   re_enrolled   boolean   - true iff the "re-enrolled" tag is present
//   homeroom      string    - "Room 7" / "Room B" / null (first room tag wins)
//   program       string    - "Toddler (Full Day)" / "Children's House 3 (Full Day)"
//                              / "Kindergarten" / "1st Grade" / null
//
// Tag-on-contact, applied-to-every-student-in-family:
//   Shrewsbury stores up to 4 students per parent contact via ghl_slot.
//   Tags are contact-level in GHL, so every student in a family inherits
//   the same tag set. If a family genuinely has kids in two rooms, both
//   students will show both room tags — display will reflect that.
//
// Idempotent. Re-runnable any time Shrewsbury updates tags in GHL.
//   node scripts/sync-shrewsbury-tags-from-ghl.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
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

const SHREWSBURY_SCHOOL_ID = 'bf5e15d7-c0df-4ac6-9b6f-ededee90b02a';
const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function decrypt(ciphertext, iv, tag) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

async function loadPit() {
  const r = await pool.query(
    `SELECT ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag
       FROM schools WHERE id = $1`,
    [SHREWSBURY_SCHOOL_ID],
  );
  if (r.rowCount === 0) throw new Error('Shrewsbury school row not found');
  const row = r.rows[0];
  return {
    locationId: row.ghl_location_id,
    pit: decrypt(row.ghl_pit_encrypted, row.ghl_pit_iv, row.ghl_pit_tag),
  };
}

async function fetchAllContacts(pit, locationId) {
  const all = [];
  let page = 1;
  const pageLimit = 100;
  while (page <= 50) {
    const res = await fetch(`${GHL_BASE}/contacts/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pit}`,
        Version: GHL_VERSION,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ locationId, pageLimit, page }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`contacts/search page ${page} failed: ${res.status} ${t}`);
    }
    const data = await res.json();
    const contacts = data.contacts ?? [];
    all.push(...contacts);
    if (contacts.length < pageLimit) break;
    page++;
  }
  return all;
}

// "room 7" -> "Room 7"; "room b" -> "Room B".
function formatRoomTag(tag) {
  const m = /^room\s+(.+)$/.exec(tag);
  if (!m) return null;
  const rest = m[1].trim();
  // Lift letter-only single-char to upper; leave digits as-is.
  if (rest.length === 1 && /[a-z]/.test(rest)) return `Room ${rest.toUpperCase()}`;
  return `Room ${rest}`;
}

// Map an age-band tag to a clean program label. Anything we don't
// recognize stays null — the dashboard will show '—' rather than
// emit garbage labels.
function formatProgramTag(tag) {
  if (/^toddler.*full\s*day/.test(tag)) return 'Toddler (Full Day)';
  if (/^toddler.*half\s*day/.test(tag)) return 'Toddler (Half Day)';
  if (/^children'?s\s*house\s*3.*full\s*day/.test(tag)) return "Children's House 3 (Full Day)";
  if (/^children'?s\s*house\s*3.*half\s*day/.test(tag)) return "Children's House 3 (Half Day)";
  if (/^children'?s\s*house\s*4.*full\s*day/.test(tag)) return "Children's House 4 (Full Day)";
  if (/^children'?s\s*house\s*4.*half\s*day/.test(tag)) return "Children's House 4 (Half Day)";
  if (/^kindergarten/.test(tag)) return 'Kindergarten';
  if (/^ch\s*pre-?primary.*full\s*day/.test(tag)) return 'CH Pre-Primary (Full Day)';
  if (/^ch\s*pre-?primary.*half-?day/.test(tag)) return 'CH Pre-Primary (Half Day)';
  if (/^1st\s*grade/.test(tag)) return '1st Grade';
  if (/^2nd\s*grade/.test(tag)) return '2nd Grade';
  if (/^3rd\s*grade/.test(tag)) return '3rd Grade';
  if (/^4th\s*grade/.test(tag)) return '4th Grade';
  if (/^5th\s*grade/.test(tag)) return '5th Grade';
  return null;
}

// Pull the derived fields from a tag array. First match wins for
// homeroom / program — fine because a Shrewsbury family with kids in
// multiple rooms is rare and surfaces as multiple room tags anyway
// (we show them all in the tags array regardless).
function deriveFromTags(tags) {
  const re_enrolled = tags.includes('re-enrolled');
  let homeroom = null;
  let program = null;
  for (const t of tags) {
    if (!homeroom) {
      const r = formatRoomTag(t);
      if (r) homeroom = r;
    }
    if (!program) {
      const p = formatProgramTag(t);
      if (p) program = p;
    }
  }
  return { re_enrolled, homeroom, program };
}

async function main() {
  const { pit, locationId } = await loadPit();
  console.log(`[shrewsbury-sync] location ${locationId}`);
  console.log(`[shrewsbury-sync] fetching all contacts (tags)…`);
  const contacts = await fetchAllContacts(pit, locationId);
  console.log(`[shrewsbury-sync] fetched ${contacts.length} contacts`);

  // Build ghl_contact_id -> normalized tag array
  const tagsByContact = new Map();
  for (const c of contacts) {
    const id = c.id;
    if (!id) continue;
    const tags = (Array.isArray(c.tags) ? c.tags : [])
      .map((t) => String(t).toLowerCase().trim())
      .filter(Boolean);
    tagsByContact.set(id, tags);
  }

  // Pull all Shrewsbury students with their ghl_contact_id
  const { rows: students } = await pool.query(
    `SELECT id, first_name, last_name, metadata->>'ghl_contact_id' AS ghl_contact_id,
            metadata AS md
       FROM students
      WHERE school_id = $1`,
    [SHREWSBURY_SCHOOL_ID],
  );
  console.log(`[shrewsbury-sync] ${students.length} students on file`);

  let updated = 0, untagged = 0, missingContact = 0;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const s of students) {
      const cid = s.ghl_contact_id;
      const tags = cid ? tagsByContact.get(cid) : null;
      if (!cid) { missingContact++; continue; }
      if (!tags || tags.length === 0) { untagged++; continue; }

      const derived = deriveFromTags(tags);
      // Merge into metadata — preserve everything we don't touch.
      const next = {
        ...(s.md || {}),
        tags,
        re_enrolled: derived.re_enrolled,
      };
      // Only set homeroom/program when we have a value — don't clobber
      // existing data with nulls.
      if (derived.homeroom) next.homeroom = derived.homeroom;
      if (derived.program)  next.program  = derived.program;

      await c.query(
        `UPDATE students SET metadata = $1::jsonb, updated_at = now() WHERE id = $2`,
        [JSON.stringify(next), s.id],
      );
      updated++;
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }

  console.log('\n──── Summary ────');
  console.log(`  Updated:           ${updated}`);
  console.log(`  Untagged contacts: ${untagged}`);
  console.log(`  Students with no ghl_contact_id: ${missingContact}`);

  // Quick post-sync breakdown
  const post = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE metadata->>'re_enrolled' = 'true')          AS re_enrolled,
      COUNT(*) FILTER (WHERE metadata->>'homeroom'   IS NOT NULL)        AS with_homeroom,
      COUNT(*) FILTER (WHERE metadata->>'program'    IS NOT NULL)        AS with_program
      FROM students WHERE school_id = $1
  `, [SHREWSBURY_SCHOOL_ID]);
  console.log('\n──── Post-sync breakdown ────');
  console.log(`  Re-enrolled flag set: ${post.rows[0].re_enrolled}`);
  console.log(`  Homeroom populated:   ${post.rows[0].with_homeroom}`);
  console.log(`  Program populated:    ${post.rows[0].with_program}`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => pool.end());
