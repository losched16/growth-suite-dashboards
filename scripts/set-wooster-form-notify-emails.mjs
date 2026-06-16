// Set all Wooster portal_form_definitions.notify_emails to a single
// shared inbox. Joe confirmed on the 2026-06-15 call he wants every
// form notification to land at woomontessori@woomontessori.org, not
// in any individual's mailbox.
//
// Usage:
//   node scripts/set-wooster-form-notify-emails.mjs            # DRY RUN
//   node scripts/set-wooster-form-notify-emails.mjs --apply    # write

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

const envText = readFileSync(join(projectRoot, '.env.local'), 'utf8');
for (const line of envText.split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('=');
  if (eq === -1) continue;
  const k = t.slice(0, eq).trim();
  if (!process.env[k]) process.env[k] = t.slice(eq + 1).trim();
}

const APPLY = process.argv.includes('--apply');
const WOOSTER_SCHOOL_ID = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
const TARGET = ['woomontessori@woomontessori.org'];

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

async function main() {
  const before = await pool.query(
    `SELECT id, slug, notify_emails
       FROM portal_form_definitions
      WHERE school_id = $1
      ORDER BY slug`,
    [WOOSTER_SCHOOL_ID],
  );

  console.log(`Found ${before.rows.length} Wooster forms.\n`);
  for (const r of before.rows) {
    const current = Array.isArray(r.notify_emails) ? r.notify_emails : [];
    const same = current.length === TARGET.length && current.every((e) => TARGET.includes(e));
    console.log(`  ${same ? ' ' : '*'} ${r.slug.padEnd(34)} → ${current.length ? current.join(', ') : '(none)'}`);
  }
  console.log(`\nTarget: ${TARGET.join(', ')}`);

  if (!APPLY) {
    console.log('\nDry run — rerun with --apply to write.');
    await pool.end();
    return;
  }

  const result = await pool.query(
    `UPDATE portal_form_definitions
        SET notify_emails = $2
      WHERE school_id = $1
        AND notify_emails IS DISTINCT FROM $2`,
    [WOOSTER_SCHOOL_ID, TARGET],
  );
  console.log(`\nUpdated ${result.rowCount} rows.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
