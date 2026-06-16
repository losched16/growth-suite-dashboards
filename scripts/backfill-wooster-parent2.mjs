// Backfill Wooster families that currently have only 1 parent in our
// DB with parent-2 data hiding in their primary GHL contact's
// custom fields:
//
//   parent_2_first_name + parent_2_last_name → required
//   parent_2_cell_phone || parent_2_phone     → optional, picked in that order
//
// Wooster's convention is that parent 2 lives as CUSTOM FIELDS on the
// primary contact, NOT as its own contact. We mirror that locally by
// creating a parents row with ghl_contact_id = NULL — the field-level
// edits will need to be synced back via the contact webhook (see
// docs/WOOSTER_PARENT2_BACKFILL.md for the architecture note).
//
// Usage:
//   node scripts/backfill-wooster-parent2.mjs            # DRY RUN
//   node scripts/backfill-wooster-parent2.mjs --apply    # write

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import axios from 'axios';
import crypto from 'node:crypto';

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

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

function decrypt(ct, iv, tag) {
  const raw = process.env.ENCRYPTION_KEY;
  let key = Buffer.from(raw, 'base64');
  if (key.length !== 32) key = Buffer.from(raw, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

const RELEVANT_KEYS = [
  'parent_2_first_name',
  'parent_2_last_name',
  'parent_2_cell_phone',
  'parent_2_phone',
];

async function main() {
  // Load Wooster PIT
  const pit = await pool.query(
    `SELECT ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag FROM schools WHERE id = $1`,
    [WOOSTER],
  );
  const token = decrypt(pit.rows[0].ghl_pit_encrypted, pit.rows[0].ghl_pit_iv, pit.rows[0].ghl_pit_tag);
  const locationId = pit.rows[0].ghl_location_id;
  const ax = axios.create({
    baseURL: 'https://services.leadconnectorhq.com',
    headers: { Authorization: `Bearer ${token}`, Version: '2021-07-28', Accept: 'application/json' },
  });

  // Load field-id → fieldKey map for the relevant 4 keys
  const cf = await ax.get(`/locations/${locationId}/customFields`);
  const idByKey = new Map();
  for (const f of cf.data?.customFields ?? []) {
    const k = (f.fieldKey ?? f.key ?? '').replace(/^contact\./, '');
    if (RELEVANT_KEYS.includes(k)) idByKey.set(k, f.id);
  }
  console.log('Resolved field IDs:');
  for (const k of RELEVANT_KEYS) console.log(`  ${k.padEnd(22)} → ${idByKey.get(k) ?? '(missing)'}`);
  if (idByKey.size < 3) throw new Error('Missing required parent_2 field defs — abort.');

  // Find every Wooster family with only 1 active parent
  const singles = await pool.query(
    `SELECT f.id AS family_id, f.display_name,
            p.id AS parent1_id, p.ghl_contact_id,
            p.first_name AS parent1_first, p.last_name AS parent1_last
       FROM families f
       JOIN parents p ON p.family_id = f.id AND p.status = 'active'
      WHERE f.school_id = $1 AND f.status = 'active' AND p.ghl_contact_id IS NOT NULL
      GROUP BY f.id, p.id
      HAVING (SELECT COUNT(*) FROM parents p2 WHERE p2.family_id = f.id AND p2.status='active') = 1
      ORDER BY f.display_name`,
    [WOOSTER],
  );
  console.log(`\n${singles.rows.length} single-parent families to inspect.\n`);

  let withData = 0;
  let inserted = 0;
  let skipped = 0;
  const summary = [];

  for (const fam of singles.rows) {
    try {
      const r = await ax.get(`/contacts/${fam.ghl_contact_id}`);
      const c = r.data?.contact ?? r.data;
      const cfArr = c.customFields ?? c.customField ?? [];

      const get = (key) => {
        const id = idByKey.get(key);
        if (!id) return null;
        const v = cfArr.find((x) => x.id === id);
        const val = v?.value ?? v?.field_value;
        if (val === null || val === undefined) return null;
        const s = String(val).trim();
        return s.length === 0 ? null : s;
      };

      const firstName = get('parent_2_first_name');
      const lastName = get('parent_2_last_name');
      const phone = get('parent_2_cell_phone') ?? get('parent_2_phone');

      if (!firstName || !lastName) {
        skipped++;
        continue;
      }

      // Self-duplicate guard: a few families typed the primary parent
      // into the parent_2 slot too. Skip those — they're noise, not a
      // real co-parent.
      const sameAsPrimary =
        firstName.trim().toLowerCase() === fam.parent1_first.trim().toLowerCase() &&
        lastName.trim().toLowerCase() === fam.parent1_last.trim().toLowerCase();
      if (sameAsPrimary) {
        console.log(`  skipping self-dup: ${fam.display_name} — parent_2 = primary`);
        skipped++;
        continue;
      }

      withData++;

      summary.push({
        family: fam.display_name,
        first_name: firstName,
        last_name: lastName,
        phone: phone ?? '—',
      });

      if (APPLY) {
        await pool.query(
          `INSERT INTO parents
             (family_id, school_id, ghl_contact_id, first_name, last_name,
              email, phone, role, is_primary, status)
           VALUES ($1, $2, NULL, $3, $4, NULL, $5, 'parent', false, 'active')`,
          [fam.family_id, WOOSTER, firstName, lastName, phone],
        );
        inserted++;
      }
    } catch (err) {
      console.log(`  fetch failed for ${fam.display_name}: ${err.response?.status ?? err.message}`);
      skipped++;
    }
  }

  console.log(`\n=== Results ===`);
  console.log(`  Families with parent-2 data: ${withData}`);
  console.log(`  Skipped (no data or fetch failed): ${skipped}`);
  if (APPLY) console.log(`  Rows inserted: ${inserted}`);
  else console.log(`  Dry run — rerun with --apply to insert.`);

  console.log(`\n=== Sample of parent-2 rows ${APPLY ? 'inserted' : 'we would insert'} ===`);
  for (const s of summary.slice(0, 25)) {
    console.log(`  ${s.family.padEnd(28)} → ${s.first_name} ${s.last_name} (${s.phone})`);
  }
  if (summary.length > 25) console.log(`  ... and ${summary.length - 25} more`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
