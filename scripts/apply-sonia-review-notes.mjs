// Apply the cleanup actions Clint flagged in his review of the
// duplicate cleanup plan (2026-06-25):
//
//  1. Cluster_6 (Iwaju/Adedolapo): rename the Enrolled opportunity
//     "Adedolapo Abiodun" → "Iwaju Akigbogun" (parent name was on
//     the student's opp), then delete the duplicate "Iwaju" DFM opp.
//  2. Cluster_7 (Aarvan/Vimala): delete the mother's duplicate opp.
//     Keep the son's Enrolled opp.
//  3. Joseph Benoit contact merge — combine the email-only and
//     phone-only contacts into one record; delete the orphan.
//
// Other items from his notes (Brown family + Cashman + 2nd-contact
// architecture) need a clarifying answer before any action — see the
// summary I'm sending him.
//
// Idempotent + logged. Default --dry-run; --execute commits.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
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

const EXECUTE = process.argv.includes('--execute');
const SHREWSBURY_SCHOOL_ID = 'bf5e15d7-c0df-4ac6-9b6f-ededee90b02a';
const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

function decrypt(b, iv, tag) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(b), d.final()]).toString('utf8');
}

async function loadPit() {
  const r = await pool.query(
    `SELECT ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag FROM schools WHERE id = $1`,
    [SHREWSBURY_SCHOOL_ID],
  );
  return { locationId: r.rows[0].ghl_location_id, pit: decrypt(r.rows[0].ghl_pit_encrypted, r.rows[0].ghl_pit_iv, r.rows[0].ghl_pit_tag) };
}

async function ghl(method, pit, path, body) {
  const r = await fetch(`${GHL_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${pit}`, Version: GHL_VERSION, Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${await r.text()}`);
  const ct = r.headers.get('content-type') || '';
  return ct.includes('application/json') ? r.json() : null;
}

async function main() {
  const { pit, locationId } = await loadPit();
  void locationId;
  const log = { mode: EXECUTE ? 'execute' : 'dry-run', actions: [] };

  // ── Action 1: Cluster_6 — Iwaju/Adedolapo ─────────────────────────
  // Step 1a: rename the Enrolled opp to the correct child name.
  await runAction(log, 'cluster_6.rename', async () => {
    if (!EXECUTE) return { planned: 'PUT /opportunities/Dh4aFduTtb2Ww3srXrFP { name: "Iwaju Akigbogun" }' };
    await ghl('PUT', pit, '/opportunities/Dh4aFduTtb2Ww3srXrFP', { name: 'Iwaju Akigbogun' });
    return { renamed: 'Adedolapo Abiodun → Iwaju Akigbogun', opportunity_id: 'Dh4aFduTtb2Ww3srXrFP' };
  });
  // Step 1b: delete the duplicate DFM opp.
  await runAction(log, 'cluster_6.delete', async () => {
    if (!EXECUTE) return { planned: 'DELETE /opportunities/x5hKT27PYafBBrXNuQER' };
    await ghl('DELETE', pit, '/opportunities/x5hKT27PYafBBrXNuQER');
    return { deleted_opportunity_id: 'x5hKT27PYafBBrXNuQER', was: 'Iwaju Akigbogun · Duplicate Family Member' };
  });

  // ── Action 2: Cluster_7 — Vimala (mother) ─────────────────────────
  await runAction(log, 'cluster_7.delete', async () => {
    if (!EXECUTE) return { planned: 'DELETE /opportunities/zdNe3i1pakvhKlRV2iBl' };
    await ghl('DELETE', pit, '/opportunities/zdNe3i1pakvhKlRV2iBl');
    return { deleted_opportunity_id: 'zdNe3i1pakvhKlRV2iBl', was: 'Vimala Thiyagarajan · Duplicate Family Member (mother\'s dup)' };
  });

  // ── Action 3: Joseph Benoit contact merge ─────────────────────────
  // Find both Joseph Benoit contacts. One has email only, one has
  // phone only. Merge by patching the email-bearing contact to also
  // include the phone, then delete the phone-only contact.
  await runAction(log, 'benoit.merge', async () => {
    const search = await ghl('POST', pit, '/contacts/search', {
      locationId, query: 'Joseph Benoit', pageLimit: 25, page: 1,
    });
    const matches = (search.contacts ?? []).filter((c) =>
      String(c.firstName ?? '').toLowerCase() === 'joseph' &&
      String(c.lastName ?? '').toLowerCase() === 'benoit',
    );
    if (matches.length !== 2) {
      return { skipped: true, reason: `expected 2 Joseph Benoit contacts, found ${matches.length}`, matches: matches.map((c) => ({ id: c.id, email: c.email, phone: c.phone })) };
    }
    const withEmail = matches.find((c) => c.email && c.email.trim());
    const withPhone = matches.find((c) => c.phone && c.phone.trim());
    if (!withEmail || !withPhone || withEmail.id === withPhone.id) {
      return { skipped: true, reason: 'could not identify distinct email-bearing + phone-bearing contacts', matches };
    }
    if (!EXECUTE) {
      return {
        planned: 'merge',
        survivor_id: withEmail.id,
        survivor_email: withEmail.email,
        will_add_phone: withPhone.phone,
        deleting_contact_id: withPhone.id,
      };
    }
    // GHL refuses to PUT a phone onto a contact while a different
    // contact still holds it (location-level no-duplicates rule).
    // Delete the orphan first, then patch the survivor with the freed
    // phone. We capture the phone value into a local before deleting
    // so we don't lose it.
    const phoneToMove = withPhone.phone;
    await ghl('DELETE', pit, `/contacts/${withPhone.id}`);
    await ghl('PUT', pit, `/contacts/${withEmail.id}`, { phone: phoneToMove });
    return {
      merged: true,
      survivor_id: withEmail.id,
      survivor_email: withEmail.email,
      added_phone: withPhone.phone,
      deleted_orphan_id: withPhone.id,
    };
  });

  const out = JSON.stringify(log, null, 2);
  console.log(out);
  writeFileSync(join(projectRoot, '..', `sonia-review-log-${EXECUTE ? 'executed' : 'dryrun'}.json`), out);
}

async function runAction(log, name, fn) {
  try {
    const result = await fn();
    log.actions.push({ name, ok: true, ...result });
    console.log(`  ✓ ${name}: ${result.skipped ? 'skipped' : 'ok'}`);
  } catch (e) {
    log.actions.push({ name, ok: false, error: e.message });
    console.error(`  ✗ ${name}: ${e.message}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => pool.end());
