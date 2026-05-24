import { readFileSync } from 'node:fs';
import pg from 'pg';

const envText = readFileSync('.env.local', 'utf8');
for (const line of envText.split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('=');
  if (eq === -1) continue;
  if (!process.env[t.slice(0, eq).trim()]) {
    process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const { rows } = await pool.query(
  `SELECT id, name, ghl_location_id
     FROM schools
    WHERE ghl_location_id ILIKE $1
       OR ghl_location_id = $2
       OR name ILIKE '%desert%'
    ORDER BY name`,
  ['%wy1qNRECEgy8lg8pKqm0%', 'wy1qNRECEgy8lg8pKqm0'],
);
console.log('Schools matching desert / wy1qNRECEgy8lg8pKqm0:');
for (const r of rows) {
  console.log(`  • ${r.name}`);
  console.log(`    school_id    = ${r.id}`);
  console.log(`    location_id  = ${r.ghl_location_id}`);
}
if (rows.length === 0) {
  console.log('  (no matches)');
}
await pool.end();
