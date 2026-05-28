// Merge the 12 confirmed duplicate student pairs in the Wooster
// roster. Each pair is two records that represent the same kid —
// usually one came from Final Forms with a DOB + preferred_name,
// the other from a partial GHL sync. We keep the better record,
// move all related data, and delete the loser.
//
// Pairs were identified by scripts/audit-wooster-duplicates.mjs
// (one-shot audit on 2026-05-26). The list is hardcoded below.
//
// Usage:
//   node scripts/merge-wooster-duplicate-students.mjs            # DRY RUN — shows what would happen
//   node scripts/merge-wooster-duplicate-students.mjs --apply    # actually merge
//
// Safety:
//   - Every merge runs in its own transaction. If anything throws,
//     the pair rolls back and the next pair still runs.
//   - For tables with unique constraints involving student_id
//     (daily_attendance, student_health_profiles, etc.) we UPDATE
//     only where no conflict exists, then DELETE leftover rows
//     under the loser id. The keep record's data wins on conflicts.
//   - All actions logged to scripts/data/wooster-merge-log.json so
//     you can audit (and, with effort, undo).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// .env loader
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

// ── The merges ──────────────────────────────────────────────────
// Each entry is { keep, loser, label, reason }.
// Convention: `keep` is the record with more data (DOB present, or
// the older created_at when both are bare). The audit picked these.
const PAIRS = [
  // Both records lack DOB — keep the older row (lower created_at).
  // The merge script verifies created_at and picks the older as keep
  // automatically, falling back to the hardcoded keep id if equal.
  { keep: 'e0cda6c4-59b2-4e34-8712-c30855c6ac7c', loser: 'cc8e0996-42c6-4e4d-9543-2878b8ab8d34',
    label: 'Marian Churpek', reason: 'Exact duplicate, both no DOB' },
  { keep: '0f370f84-934e-4b60-96f4-1bf0a8919997', loser: '3d095ce2-d0b7-49bd-bd7d-63a4a418513a',
    label: 'Beau Overmyer', reason: 'Exact duplicate, both no DOB' },

  // One has DOB + preferred_name, other doesn't — keep the richer one.
  { keep: 'db8a55f0-56dc-49f3-a0c7-531ac3b1f0c7', loser: '59b908c4-a881-4e9f-a9a8-d222de91369d',
    label: 'Sydney Carr',     reason: 'Keep has DOB 2019-06-24 + preferred_name' },
  { keep: '2dbdea0e-9669-40fa-a64f-dc9227c8a5a7', loser: '3f57c0c6-c0b4-46d0-8a1d-3e8e797495c6',
    label: 'Cruz Dravenstott', reason: 'Keep has DOB 2018-10-03 + preferred_name' },
  { keep: '03d5e5f6-3e34-43c2-a458-0d8099ae3e83', loser: 'cd1697ab-6733-4d47-865a-4b81fdba3da0',
    label: 'Connar Dunlap',   reason: 'Keep has DOB 2012-06-28; loser is lowercase "dunlap"' },
  { keep: '21ebb1fe-47bd-4bc7-bed1-066cbfc0c55c', loser: '7a4a7be8-95e4-4967-af85-acce1bf5af2f',
    label: 'Isaiah Gibbs',    reason: 'Keep has DOB 2018-08-15' },
  { keep: '16349f2e-3864-4250-984c-d9d1d1e9a613', loser: '74a2be99-80e7-4c1a-933f-b2a1cbf7cbd4',
    label: 'Julian "Jude" Lee', reason: 'Keep has DOB 2019-03-08' },
  { keep: 'bb5a3a73-8e67-4502-882e-2224922326e0', loser: '8185fb91-19bd-4193-a415-4e30c2bc6151',
    label: 'Braxton McClintock', reason: 'Keep has DOB 2015-01-04; loser is typo "McClintok"' },
  { keep: '246201b4-433f-42ba-bf45-0e513766107b', loser: '7a726b4c-0d87-4c63-9e44-7118263c676b',
    label: 'Lenka Velasquez Robinson', reason: 'Keep has DOB 2013-10-27; loser spelled "Velazquez"' },

  // Same family, same first name but the loser is also missing data
  // and has a hyphenated or nickname variant.
  { keep: 'b4911f18-bb45-48ea-8ab2-214dc6ad7842', loser: '3f277c85-76ef-482b-ac12-a57e70ec761d',
    label: 'Zoe Boord-Falter', reason: 'Keep has DOB + full hyphenated last name; loser is "Boord" no DOB' },
  { keep: 'd584e73c-d11d-4a57-a313-8c8b6d1447d3', loser: 'a0a8b01b-62a9-4429-89d0-785344cc6451',
    label: 'Zachary "Zach" Stewart', reason: 'Keep has DOB 2013-03-01 + full first name; loser is "Zach" no DOB' },
];

// ── Tables we update on merge ───────────────────────────────────
// Plain UPDATE — no unique constraint on student_id.
const SIMPLE_TABLES = [
  'attendance_events',
  'enrollment_invites',
  'enrollments',
  'fa_applications',
  'invoice_line_items',
  'invoices',
  'parent_uploads',
  'portal_form_submissions',
  'portal_migration_flags',
  'product_purchases',
  'student_documents',
  'student_pickup_restrictions',
];
// Tables where (student_id, …) is unique. Strategy: UPDATE loser→keep
// where no row already exists for keep with the same conflicting key,
// then DELETE leftover loser rows. Keep's data wins on conflicts.
const UNIQUE_TABLES = [
  // table             other unique cols (for the EXISTS subquery)
  { table: 'daily_attendance',           keyCols: ['date'] },
  { table: 'student_health_profiles',    keyCols: [] },          // only student_id+school_id unique
  { table: 'family_tuition_enrollments', keyCols: ['family_id', 'academic_year'] },
  { table: 'parent_student_assignments', keyCols: ['parent_id'] },
  { table: 'fa_application_students',    keyCols: ['application_id'] },
];

async function mergeOnePair(client, pair, dryRun) {
  // Resolve which record is *actually* the better keep — when both
  // are equally bare we use the older created_at instead of trusting
  // the hardcoded choice.
  const cmp = await client.query(
    `SELECT id, first_name, last_name, preferred_name, date_of_birth, created_at, family_id
       FROM students WHERE id = ANY($1::uuid[])`,
    [[pair.keep, pair.loser]],
  );
  if (cmp.rows.length !== 2) {
    return { skipped: true, reason: 'one or both ids not found' };
  }
  const a = cmp.rows.find((r) => r.id === pair.keep);
  const b = cmp.rows.find((r) => r.id === pair.loser);
  if (a.family_id !== b.family_id) {
    return { skipped: true, reason: `family_id mismatch — abort to avoid cross-family contamination` };
  }
  // Prefer record with DOB; if both equal, prefer older created_at.
  const aBetter = (!!a.date_of_birth && !b.date_of_birth)
    || (!!a.date_of_birth === !!b.date_of_birth && a.created_at <= b.created_at);
  const keep = aBetter ? a : b;
  const loser = aBetter ? b : a;

  const moved = {};
  const conflicted = {};

  // 1) Plain UPDATEs
  for (const t of SIMPLE_TABLES) {
    const r = await client.query(
      `UPDATE ${t} SET student_id = $1 WHERE student_id = $2 RETURNING 1`,
      [keep.id, loser.id],
    );
    if (r.rowCount > 0) moved[t] = r.rowCount;
  }

  // 2) Unique-constraint tables: UPDATE where no conflict, then DELETE leftovers
  for (const { table, keyCols } of UNIQUE_TABLES) {
    const keepCols = keyCols.length > 0
      ? ` AND NOT EXISTS (SELECT 1 FROM ${table} k WHERE k.student_id = $1 ${keyCols.map((k, i) => `AND k.${k} = ${table}.${k}`).join(' ')})`
      : ` AND NOT EXISTS (SELECT 1 FROM ${table} k WHERE k.student_id = $1)`;
    const up = await client.query(
      `UPDATE ${table} SET student_id = $1 WHERE student_id = $2${keepCols} RETURNING 1`,
      [keep.id, loser.id],
    );
    if (up.rowCount > 0) moved[table] = up.rowCount;
    const left = await client.query(
      `DELETE FROM ${table} WHERE student_id = $1 RETURNING 1`,
      [loser.id],
    );
    if (left.rowCount > 0) conflicted[table] = left.rowCount;
  }

  // 3) Delete the loser student row
  await client.query(`DELETE FROM students WHERE id = $1`, [loser.id]);

  return {
    keptId: keep.id,
    loserId: loser.id,
    keptLabel: `${keep.first_name}${keep.preferred_name ? ' (' + keep.preferred_name + ')' : ''} ${keep.last_name} · DOB ${keep.date_of_birth ? keep.date_of_birth.toISOString().slice(0, 10) : 'none'}`,
    loserLabel: `${loser.first_name}${loser.preferred_name ? ' (' + loser.preferred_name + ')' : ''} ${loser.last_name} · DOB ${loser.date_of_birth ? loser.date_of_birth.toISOString().slice(0, 10) : 'none'}`,
    moved,
    conflicted_deleted: conflicted,
  };
}

async function main() {
  console.log(`Mode: ${APPLY ? '\x1b[31mAPPLY\x1b[0m (writes)' : '\x1b[36mDRY RUN\x1b[0m (no writes)'}`);
  console.log(`Wooster duplicate-student merger — ${PAIRS.length} pair${PAIRS.length === 1 ? '' : 's'}\n`);

  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  const log = [];
  let succeeded = 0;
  let skipped = 0;

  for (const pair of PAIRS) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const res = await mergeOnePair(client, pair, !APPLY);
      if (res.skipped) {
        await client.query('ROLLBACK');
        console.log(`  ⚠️  ${pair.label.padEnd(32)} SKIPPED: ${res.reason}`);
        skipped++;
        continue;
      }
      if (!APPLY) await client.query('ROLLBACK');
      else       await client.query('COMMIT');

      console.log(`  ${APPLY ? '✓' : '◌'} ${pair.label.padEnd(32)}`);
      console.log(`      KEEP : ${res.keptLabel}  (id=${res.keptId})`);
      console.log(`      LOSER: ${res.loserLabel}  (id=${res.loserId})`);
      if (Object.keys(res.moved).length > 0) {
        const summary = Object.entries(res.moved).map(([t, n]) => `${t}=${n}`).join(', ');
        console.log(`      moved: ${summary}`);
      }
      if (Object.keys(res.conflicted_deleted).length > 0) {
        const summary = Object.entries(res.conflicted_deleted).map(([t, n]) => `${t}=${n}`).join(', ');
        console.log(`      conflicted (deleted, keep's data wins): ${summary}`);
      }
      console.log('');
      log.push({ pair: pair.label, reason: pair.reason, ...res, applied: APPLY });
      succeeded++;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.log(`  ✗ ${pair.label}: ${e.message}`);
      log.push({ pair: pair.label, error: e.message });
    } finally {
      client.release();
    }
  }

  console.log(`\nDone. ${succeeded} merged, ${skipped} skipped.`);

  if (APPLY) {
    const outPath = join(projectRoot, 'scripts', 'data', 'wooster-merge-log.json');
    const existing = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : [];
    existing.push({ run_at: new Date().toISOString(), entries: log });
    writeFileSync(outPath, JSON.stringify(existing, null, 2));
    console.log(`Audit log appended to ${outPath}`);
  }

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
