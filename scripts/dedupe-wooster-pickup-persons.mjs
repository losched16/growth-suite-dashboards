// Dedupe duplicate pickup_persons rows at Wooster.
//
// 21 names appeared multiple times — each parent in a family re-added
// the same grandparent, nanny, etc. With migration 045 in place we
// can't have duplicates going forward; this script collapses the
// existing ones.
//
// Strategy per name group (within a single family):
//   1. Pick the KEEPER — the active row with the lowest created_at,
//      falling back to the lowest-created_at row regardless of active.
//   2. For each LOSER:
//      - move any kiosk events (attendance_events.picked_up_by_pickup_person_id)
//        to the keeper's id
//      - if the keeper has no PIN but the loser does, transfer the PIN
//      - delete the loser
//   3. Make sure the keeper is active (in case all rows were inactive
//      but at least one of the dupes was being used).
//
// Run with --apply to write. Default is dry-run.

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
const WOOSTER = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';

async function main() {
  console.log(`Mode: ${APPLY ? '\x1b[31mAPPLY\x1b[0m (writes)' : '\x1b[36mDRY RUN\x1b[0m'}`);

  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  // Find every duplicate group by (family_id, lower(name)) — family_id
  // was populated by migration 045's backfill.
  const { rows: groups } = await pool.query(
    `SELECT family_id, lower(name) AS norm_name, COUNT(*) AS cnt,
            jsonb_agg(jsonb_build_object(
              'id', id, 'name', name, 'active', active, 'created_at', created_at,
              'pin_hash', pin_hash, 'pin_set_at', pin_set_at, 'pin_expires_at', pin_expires_at,
              'phone', phone, 'notes', notes, 'relationship', relationship
            ) ORDER BY active DESC, created_at) AS rows
       FROM pickup_persons
      WHERE school_id = $1
      GROUP BY family_id, lower(name)
      HAVING COUNT(*) > 1`,
    [WOOSTER],
  );

  console.log(`\nFound ${groups.length} duplicate group${groups.length === 1 ? '' : 's'}:\n`);

  let totalDeleted = 0;
  let totalEventsMoved = 0;
  let totalPinsTransferred = 0;

  for (const g of groups) {
    // KEEPER = first active by created_at; if none active, oldest overall.
    const sorted = g.rows;
    const firstActive = sorted.find((r) => r.active);
    const keeper = firstActive ?? sorted[0];
    const losers = sorted.filter((r) => r.id !== keeper.id);

    console.log(`  Group: ${keeper.name} (family ${g.family_id.slice(0, 8)}…)`);
    console.log(`    KEEP : ${keeper.id} (active=${keeper.active}, pin=${keeper.pin_hash ? 'yes' : 'no'}, created=${new Date(keeper.created_at).toISOString().slice(0, 10)})`);

    const client = await pool.connect();
    try {
      if (APPLY) await client.query('BEGIN');

      for (const loser of losers) {
        // 1) Move kiosk events to keeper
        const ev = await client.query(
          `UPDATE attendance_events
              SET picked_up_by_pickup_person_id = $1
            WHERE picked_up_by_pickup_person_id = $2
            RETURNING 1`,
          [keeper.id, loser.id],
        );
        if (ev.rowCount > 0) totalEventsMoved += ev.rowCount;

        // 2) Transfer PIN if keeper doesn't have one but loser does
        const pinTransfer = !keeper.pin_hash && loser.pin_hash;
        if (pinTransfer) {
          await client.query(
            `UPDATE pickup_persons
                SET pin_hash = $1, pin_set_at = $2, pin_expires_at = $3
              WHERE id = $4`,
            [loser.pin_hash, loser.pin_set_at, loser.pin_expires_at, keeper.id],
          );
          // Reflect locally so subsequent losers don't double-transfer.
          keeper.pin_hash = loser.pin_hash;
          keeper.pin_set_at = loser.pin_set_at;
          keeper.pin_expires_at = loser.pin_expires_at;
          totalPinsTransferred++;
        }

        // 3) Delete loser
        await client.query(`DELETE FROM pickup_persons WHERE id = $1`, [loser.id]);

        console.log(`    LOSER: ${loser.id} → deleted${ev.rowCount > 0 ? `; moved ${ev.rowCount} event${ev.rowCount === 1 ? '' : 's'}` : ''}${pinTransfer ? '; PIN transferred to keeper' : ''}`);
        totalDeleted++;
      }

      // 4) Make sure the keeper is active (if any loser had been the
      // actively-used row, the keeper might be marked inactive).
      if (!keeper.active) {
        await client.query(`UPDATE pickup_persons SET active = true WHERE id = $1`, [keeper.id]);
        console.log(`    re-activated keeper`);
      }

      if (APPLY) await client.query('COMMIT');
      else       await client.query('ROLLBACK');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.log(`    ✗ rolled back: ${e.message}`);
    } finally {
      client.release();
    }
    console.log('');
  }

  console.log(`Done. ${groups.length} group${groups.length === 1 ? '' : 's'} processed, ${totalDeleted} loser row${totalDeleted === 1 ? '' : 's'} deleted, ${totalEventsMoved} kiosk event${totalEventsMoved === 1 ? '' : 's'} moved, ${totalPinsTransferred} PIN${totalPinsTransferred === 1 ? '' : 's'} transferred.`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
