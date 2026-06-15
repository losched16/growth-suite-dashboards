// One-shot: upload the MCH 2026-27 Parent Handbook PDF into the
// school_documents table so it appears under Important Documents in
// every MCH family's parent portal.
//
// Re-runnable: if a row with the same title already exists at MCH,
// we skip (idempotent). To replace the file, deactivate the existing
// row via the school admin UI first and re-run.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// Load env (same pattern as the other scripts).
const envText = readFileSync(join(projectRoot, '.env.local'), 'utf8');
for (const line of envText.split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('=');
  if (eq === -1) continue;
  const k = t.slice(0, eq).trim();
  if (!process.env[k]) process.env[k] = t.slice(eq + 1).trim();
}

const MCH_SCHOOL_ID = 'a6c4b2dd-050c-4bf9-893b-67106f0f20e8';
const FILE_PATH = process.env.USERPROFILE
  ? `${process.env.USERPROFILE}\\Downloads\\MCH Handbook 2026-27..pdf`
  : '/c/Users/thelo/Downloads/MCH Handbook 2026-27..pdf';

const TITLE = 'Parent Handbook 2026-2027';
const DESCRIPTION = 'The full parent handbook for the 2026-2027 school year — policies, schedules, and what to expect at Media Children\'s House.';
const CATEGORY = 'Parent Handbook';
const ORIGINAL_FILENAME = 'MCH Handbook 2026-27.pdf';

if (!existsSync(FILE_PATH)) {
  console.error(`File not found: ${FILE_PATH}`);
  console.error('If the path is different on your machine, set MCH_HANDBOOK_PATH env var or edit FILE_PATH in this script.');
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  const bytes = readFileSync(FILE_PATH);
  console.log(`Read ${(bytes.length / 1024 / 1024).toFixed(2)} MB from ${FILE_PATH}`);

  // Idempotency: skip if MCH already has a doc with this title +
  // is_active=true. Safe to re-run if the operator deletes via the
  // school admin UI first.
  const { rows: existing } = await pool.query(
    `SELECT id, original_filename FROM school_documents
      WHERE school_id = $1 AND title = $2 AND is_active = true`,
    [MCH_SCHOOL_ID, TITLE],
  );
  if (existing.length > 0) {
    console.log(`  ⊝ Already uploaded as "${TITLE}" (id=${existing[0].id}, file=${existing[0].original_filename}). Skipping.`);
    console.log('  → To replace: deactivate via the school admin UI, then re-run.');
    await pool.end();
    return;
  }

  // Position: append to the end of the category (no existing
  // Parent Handbook docs, so this lands at 10).
  const { rows: pRows } = await pool.query(
    `SELECT COALESCE(MAX(position), 0) + 10 AS next_pos
       FROM school_documents
      WHERE school_id = $1 AND COALESCE(category, '') = $2`,
    [MCH_SCHOOL_ID, CATEGORY],
  );
  const position = pRows[0]?.next_pos ?? 10;

  const { rows: ins } = await pool.query(
    `INSERT INTO school_documents
        (school_id, title, description, category,
         original_filename, mime_type, size_bytes, contents, position,
         uploaded_by_email)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      MCH_SCHOOL_ID, TITLE, DESCRIPTION, CATEGORY,
      ORIGINAL_FILENAME, 'application/pdf',
      bytes.length, bytes, position,
      'clint@getaims.co',
    ],
  );
  console.log(`  ✓ Uploaded as id=${ins[0].id}. MCH parents will see it under Important Documents → Parent Handbook.`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
