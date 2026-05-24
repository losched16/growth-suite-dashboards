// Seeds demo passwords for the parent accounts we use in walkthroughs.
// Idempotent — running it twice replaces the password (so you can
// rotate the demo creds without DB surgery).
//
// PASSWORDS ARE HARDCODED IN THIS FILE FOR DEMO PURPOSES ONLY. In
// production, parents set their own via the /login flow.
//
// Run:
//   node scripts/seed-demo-passwords.mjs

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

const DEMO_PASSWORDS = [
  // email                            password
  ['michellelynnpt@gmail.com',        'dgm-demo-2026'],
  ['lauren.liu278@gmail.com',         'wooster-demo-2026'],
];

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const buf = await scrypt(plain, salt, 32);
  return `${salt}:${buf.toString('hex')}`;
}

async function main() {
  const c = await pool.connect();
  try {
    let stamped = 0;
    for (const [email, password] of DEMO_PASSWORDS) {
      const hash = await hashPassword(password);
      const { rowCount } = await c.query(
        `UPDATE parents
            SET password_hash = $1,
                password_set_at = now(),
                updated_at = now()
          WHERE LOWER(email) = LOWER($2) AND status = 'active'`,
        [hash, email],
      );
      if (rowCount && rowCount > 0) {
        stamped += rowCount;
        console.log(`✓ Set demo password for ${email} → "${password}" (${rowCount} parent row${rowCount === 1 ? '' : 's'})`);
      } else {
        console.log(`✗ No active parent found for ${email}`);
      }
    }
    console.log(`\nTotal: ${stamped} parent record(s) updated.`);
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
