// Investigate: where (if anywhere) is parent-2 data hiding for Wooster
// families? Looks in three places:
//
//   1. portal_form_submissions.responses — any key matching
//      parent_2_*, second_parent_*, mother_*, father_*, p2_*, etc.
//   2. ghl_attributes_catalog — any catalog entry with a parent-2 ish key
//   3. parents table — how many Wooster families have 1 vs 2+ parents
//
// Read-only.

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

const WOOSTER = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

async function main() {
  // 1. Distribution of parent counts per family
  const dist = await pool.query(
    `SELECT parent_count, COUNT(*)::int AS family_count
       FROM (
         SELECT f.id AS family_id, COUNT(p.id) AS parent_count
           FROM families f
           LEFT JOIN parents p ON p.family_id = f.id AND p.status = 'active'
          WHERE f.school_id = $1 AND f.status = 'active'
          GROUP BY f.id
       ) t
      GROUP BY parent_count
      ORDER BY parent_count`,
    [WOOSTER],
  );
  console.log('=== Wooster parent count per family ===');
  for (const r of dist.rows) {
    console.log(`  ${r.parent_count} parents → ${r.family_count} families`);
  }

  // 2. Sample one submission per form and dump all top-level keys to
  //    look for parent-2 patterns.
  const formKeys = await pool.query(
    `SELECT d.slug,
            (SELECT s.responses FROM portal_form_submissions s
              WHERE s.form_definition_id = d.id
              ORDER BY s.submitted_at DESC LIMIT 1) AS sample
       FROM portal_form_definitions d
      WHERE d.school_id = $1
      ORDER BY d.slug`,
    [WOOSTER],
  );

  console.log('\n=== Form submission keys (one sample per form) ===');
  const parentLike = /parent[_-]?2|second[_-]?parent|p2_|partner|spouse|mother|father|guardian/i;
  for (const r of formKeys.rows) {
    if (!r.sample) {
      console.log(`  ${r.slug}: (no submissions)`);
      continue;
    }
    const keys = Object.keys(r.sample);
    const hits = keys.filter((k) => parentLike.test(k));
    console.log(`  ${r.slug}: ${keys.length} keys, ${hits.length} parent-2-like`);
    if (hits.length > 0) {
      for (const k of hits) console.log(`      ${k} = ${JSON.stringify(r.sample[k]).slice(0, 80)}`);
    }
  }

  // 3. Aggregate: count submissions that have any parent-2-like key
  console.log('\n=== Submissions with parent-2-like keys ===');
  const agg = await pool.query(
    `SELECT d.slug, COUNT(*)::int AS total, COUNT(*) FILTER (
       WHERE EXISTS (
         SELECT 1 FROM jsonb_object_keys(s.responses) k
         WHERE k ~* 'parent[_-]?2|second[_-]?parent|p2_|partner|spouse|mother|father|guardian'
       )
     )::int AS with_parent2
       FROM portal_form_submissions s
       JOIN portal_form_definitions d ON d.id = s.form_definition_id
      WHERE s.school_id = $1
      GROUP BY d.slug
      ORDER BY with_parent2 DESC`,
    [WOOSTER],
  );
  for (const r of agg.rows) {
    if (r.with_parent2 > 0) console.log(`  ${r.slug.padEnd(30)} ${r.with_parent2}/${r.total}`);
  }

  // 4. ghl_attributes_catalog entries that look parent-2-y
  console.log('\n=== ghl_attributes_catalog (parent-2-ish) ===');
  const cat = await pool.query(
    `SELECT field_key, display_name
       FROM ghl_attributes_catalog
      WHERE school_id = $1
        AND field_key ~* 'parent[_-]?2|second[_-]?parent|p2_|partner|spouse|mother|father|guardian'
      ORDER BY field_key`,
    [WOOSTER],
  );
  if (cat.rows.length === 0) console.log('  (none)');
  for (const r of cat.rows) console.log(`  ${r.field_key.padEnd(40)} ${r.display_name ?? ''}`);

  // 5. One concrete enrollment-agreement sample so we can eyeball
  //    what real parent-2 data looks like.
  const sample = await pool.query(
    `SELECT s.responses, f.display_name
       FROM portal_form_submissions s
       JOIN portal_form_definitions d ON d.id = s.form_definition_id
       JOIN families f ON f.id = s.family_id
      WHERE s.school_id = $1 AND d.slug = 'enrollment-agreement'
        AND EXISTS (
          SELECT 1 FROM jsonb_object_keys(s.responses) k
          WHERE k ~* 'parent[_-]?2|second[_-]?parent|p2_|partner|spouse|mother|father|guardian'
        )
      ORDER BY s.submitted_at DESC LIMIT 1`,
    [WOOSTER],
  );
  if (sample.rows.length > 0) {
    console.log(`\n=== Sample enrollment-agreement (${sample.rows[0].display_name}) — parent-2 keys only ===`);
    const r = sample.rows[0].responses;
    const parentKeys = Object.keys(r).filter((k) =>
      /parent[_-]?2|second[_-]?parent|p2_|partner|spouse|mother|father|guardian/i.test(k),
    );
    for (const k of parentKeys) {
      console.log(`  ${k.padEnd(36)} = ${JSON.stringify(r[k])}`);
    }
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
