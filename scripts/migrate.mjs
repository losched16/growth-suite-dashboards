// Idempotent migration runner. Tracks applied migrations in a per-app
// _gsd_migrations table (separate from importer/family-graph trackers).
// Usage: node scripts/migrate.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

const envText = readFileSync(join(projectRoot, '.env.local'), 'utf8');
for (const line of envText.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq).trim();
  const value = trimmed.slice(eq + 1).trim();
  if (!process.env[key]) process.env[key] = value;
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set.');
  process.exit(1);
}

const migrationsDir = join(projectRoot, 'migrations');
const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

try {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _gsd_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const { rows: applied } = await pool.query('SELECT filename FROM _gsd_migrations');
  const appliedSet = new Set(applied.map((r) => r.filename));

  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`Skipping ${file} (already applied)`);
      continue;
    }
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    console.log(`Applying ${file}...`);
    await pool.query(sql);
    await pool.query('INSERT INTO _gsd_migrations (filename) VALUES ($1)', [file]);
    console.log(`  ok`);
  }

  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`
  );
  console.log('\nPublic tables now in DB:');
  for (const r of rows) console.log(`  - ${r.table_name}`);
} catch (err) {
  console.error('Migration failed:', err.message);
  process.exit(1);
} finally {
  await pool.end();
}
