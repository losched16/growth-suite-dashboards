// Replay the 16 (and counting) Wooster webhook events that landed as
// status='ignored' because resolveSchoolId returned null. For each
// distinct contact_id, fetch the canonical record from GHL and apply
// it the same way the webhook handler now would.
//
// Idempotent — uses the same COALESCE-don't-blank logic.

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
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

function decrypt(ct, iv, tag) {
  const raw = process.env.ENCRYPTION_KEY;
  let key = Buffer.from(raw, 'base64');
  if (key.length !== 32) key = Buffer.from(raw, 'hex');
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

async function main() {
  const { rows: dropped } = await pool.query(
    `SELECT DISTINCT ON (ghl_contact_id) ghl_contact_id, received_at
       FROM ghl_webhook_log
      WHERE status = 'ignored'
        AND ghl_contact_id IS NOT NULL
        AND received_at > now() - interval '7 days'
      ORDER BY ghl_contact_id, received_at DESC`,
  );

  console.log(`${dropped.length} distinct contacts to replay.\n`);

  // Resolve school per contact + group
  const bySchool = new Map();
  for (const r of dropped) {
    const p = await pool.query(
      `SELECT school_id FROM parents WHERE ghl_contact_id = $1 LIMIT 1`,
      [r.ghl_contact_id],
    );
    const sid = p.rows[0]?.school_id;
    if (!sid) {
      console.log(`  SKIP   ${r.ghl_contact_id} — no parent row`);
      continue;
    }
    if (!bySchool.has(sid)) bySchool.set(sid, []);
    bySchool.get(sid).push(r.ghl_contact_id);
  }

  let applied = 0, skipped = 0;
  for (const [schoolId, contactIds] of bySchool) {
    const s = await pool.query(
      `SELECT ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag FROM schools WHERE id = $1`,
      [schoolId],
    );
    const token = decrypt(s.rows[0].ghl_pit_encrypted, s.rows[0].ghl_pit_iv, s.rows[0].ghl_pit_tag);
    const locationId = s.rows[0].ghl_location_id;
    const ax = axios.create({
      baseURL: 'https://services.leadconnectorhq.com',
      headers: { Authorization: `Bearer ${token}`, Version: '2021-07-28', Accept: 'application/json' },
      timeout: 20_000,
    });

    console.log(`\n--- School ${schoolId} (${contactIds.length} contacts) ---`);
    for (const cid of contactIds) {
      try {
        const r = await ax.get(`/contacts/${cid}`);
        const c = r.data?.contact ?? r.data;
        const firstName = c.firstName?.trim() || null;
        const lastName = c.lastName?.trim() || null;
        const email = c.email ?? null;
        const phone = c.phone ?? null;

        // Match the webhook's basic apply (per-student & parent_2
        // cascade are handled on next real webhook).
        if (APPLY) {
          const upd = await pool.query(
            `UPDATE parents
                SET first_name = COALESCE($3, first_name),
                    last_name  = COALESCE($4, last_name),
                    email      = COALESCE($5, email),
                    phone      = COALESCE($6, phone),
                    updated_at = now()
              WHERE school_id = $1 AND ghl_contact_id = $2`,
            [schoolId, cid, firstName, lastName, email, phone],
          );
          console.log(`  APPLIED   ${cid} → ${firstName} ${lastName} (${upd.rowCount} row)`);
          applied++;
        } else {
          console.log(`  WOULD     ${cid} → ${firstName} ${lastName} (${email})`);
          applied++;
        }
      } catch (err) {
        console.log(`  FAILED    ${cid} — ${err.response?.status ?? ''} ${err.response?.data?.message ?? err.message}`);
        skipped++;
      }
      // light rate limit
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`  ${APPLY ? 'Applied' : 'Would apply'}: ${applied}`);
  console.log(`  Skipped: ${skipped}`);
  if (!APPLY) console.log(`  Dry run — rerun with --apply to write.`);
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
