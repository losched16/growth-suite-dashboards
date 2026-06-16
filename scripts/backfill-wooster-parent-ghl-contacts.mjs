// Ensure every emailable Wooster parent has a GHL contact id linked.
//
// Background: we have 374 active Wooster parents. 153 already have a
// ghl_contact_id from the original sync. 189 have an email but no
// contact — that splits into:
//
//   - 134 parent-2 rows the backfill created (no contact by design)
//   - 55 primary parents who came from CSV/legacy import without ever
//     being linked
//
// With Wooster's email_provider='ghl', the GHL Conversations API needs
// a contactId to send. No contact → silent send failure. This script
// closes that gap:
//
//   For each parent with email + NULL ghl_contact_id:
//     1. Search GHL by email
//     2. If found → just link
//     3. If not found → create + link
//
// Idempotent: skips anyone who already has a ghl_contact_id.
//
// Usage:
//   node scripts/backfill-wooster-parent-ghl-contacts.mjs            # DRY RUN
//   node scripts/backfill-wooster-parent-ghl-contacts.mjs --apply    # write

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
const RATE_DELAY_MS = 120; // ~8 req/sec — under GHL's 10/sec/location

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const pit = await pool.query(
    `SELECT ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag FROM schools WHERE id = $1`,
    [WOOSTER],
  );
  const token = decrypt(pit.rows[0].ghl_pit_encrypted, pit.rows[0].ghl_pit_iv, pit.rows[0].ghl_pit_tag);
  const locationId = pit.rows[0].ghl_location_id;
  const ax = axios.create({
    baseURL: 'https://services.leadconnectorhq.com',
    headers: {
      Authorization: `Bearer ${token}`,
      Version: '2021-07-28',
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    timeout: 20_000,
  });

  // All emailable Wooster parents without a ghl_contact_id
  const { rows: targets } = await pool.query(
    `SELECT id, first_name, last_name, email, phone, is_primary
       FROM parents
      WHERE school_id = $1
        AND status = 'active'
        AND email IS NOT NULL
        AND email <> ''
        AND ghl_contact_id IS NULL
      ORDER BY is_primary DESC, last_name, first_name`,
    [WOOSTER],
  );

  // Group by normalized email — the same person can appear as a parent
  // in multiple families. We want ONE GHL contact per email, linked from
  // all matching parent rows.
  const byEmail = new Map();
  for (const p of targets) {
    const key = p.email.trim().toLowerCase();
    if (!byEmail.has(key)) byEmail.set(key, { repr: p, rows: [] });
    const slot = byEmail.get(key);
    slot.rows.push(p);
    // Prefer a primary as the representative (better source for first/last).
    if (p.is_primary && !slot.repr.is_primary) slot.repr = p;
  }

  console.log(`\n${targets.length} parent rows → ${byEmail.size} unique emails to backfill.\n`);

  let linkedExisting = 0;
  let created = 0;
  let failed = 0;
  let rowsUpdated = 0;

  let idx = 0;
  for (const [email, { repr, rows }] of byEmail) {
    idx++;
    const tag = `[${idx}/${byEmail.size}]`;
    const dupSuffix = rows.length > 1 ? ` (×${rows.length} rows)` : '';
    try {
      // 1. Search by email
      const { data: search } = await ax.post('/contacts/search', {
        locationId,
        pageLimit: 5,
        page: 1,
        filters: [{ field: 'email', operator: 'eq', value: email }],
      });
      const found = (search.contacts ?? []).find(
        (c) => (c.email ?? '').trim().toLowerCase() === email,
      );

      let contactId = found?.id;
      let action;

      if (contactId) {
        action = 'link-existing';
        linkedExisting++;
      } else {
        if (!APPLY) {
          console.log(`${tag} WOULD CREATE ${repr.first_name} ${repr.last_name}${dupSuffix} (${email})`);
          created++;
          continue;
        }
        const { data: createRes } = await ax.post('/contacts/', {
          locationId,
          firstName: repr.first_name,
          lastName: repr.last_name,
          email: repr.email,
          ...(repr.phone ? { phone: repr.phone } : {}),
          source: 'Parent Portal backfill — parent 2 / legacy import',
        });
        contactId = createRes.contact?.id;
        if (!contactId) throw new Error('Create returned no contact.id');
        action = 'create';
        created++;
      }

      if (APPLY) {
        // Link EVERY parent row sharing this email to the same contact.
        const ids = rows.map((r) => r.id);
        const upd = await pool.query(
          `UPDATE parents
              SET ghl_contact_id = $1, updated_at = now()
            WHERE id = ANY($2::uuid[]) AND ghl_contact_id IS NULL`,
          [contactId, ids],
        );
        rowsUpdated += upd.rowCount ?? 0;
      }

      const role = repr.is_primary ? 'PRIMARY' : 'P2     ';
      console.log(`${tag} ${action.padEnd(14)} ${role} ${repr.first_name} ${repr.last_name}${dupSuffix} → ${contactId}`);
    } catch (err) {
      failed++;
      const status = err.response?.status;
      const msg = err.response?.data?.message ?? err.message;
      console.log(`${tag} FAILED         ${repr.first_name} ${repr.last_name}${dupSuffix} (${email}) — ${status ?? ''} ${msg}`);
    }

    if (idx < byEmail.size) await sleep(RATE_DELAY_MS);
  }

  console.log(`\n=== Summary ===`);
  console.log(`  Unique emails processed:        ${byEmail.size}`);
  console.log(`  Linked to existing GHL contact: ${linkedExisting}`);
  console.log(`  Created new GHL contact:        ${created}`);
  console.log(`  Failed:                         ${failed}`);
  if (APPLY) console.log(`  Parent rows updated:            ${rowsUpdated}`);
  else console.log(`\n  Dry run — rerun with --apply to write.`);

  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
