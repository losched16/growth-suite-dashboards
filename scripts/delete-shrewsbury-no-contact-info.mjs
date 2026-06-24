// Delete every Shrewsbury GHL contact with NO email AND NO phone.
// Per Clint 2026-06-25: these are partial form submissions / orphaned
// stubs. Tags + assigned-to are ignored — if we can't reach the family,
// the record has no value.
//
// Idempotent + logged. Default dry-run; --execute commits.

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
const LOG_PATH = join(projectRoot, '..', `shrewsbury-no-contact-info-${EXECUTE ? 'executed' : 'dryrun'}.json`);

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
  return {
    locationId: r.rows[0].ghl_location_id,
    pit: decrypt(r.rows[0].ghl_pit_encrypted, r.rows[0].ghl_pit_iv, r.rows[0].ghl_pit_tag),
  };
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

async function fetchAllContacts(pit, locationId) {
  const all = [];
  let page = 1;
  while (page <= 50) {
    const j = await ghl('POST', pit, '/contacts/search', { locationId, pageLimit: 100, page });
    const contacts = j.contacts ?? [];
    all.push(...contacts);
    if (contacts.length < 100) break;
    page++;
  }
  return all;
}

function hasContactInfo(c) {
  const email = (c.email || '').trim();
  const phone = (c.phone || '').trim();
  return email !== '' || phone !== '';
}

async function main() {
  const { pit, locationId } = await loadPit();
  console.log(`[no-contact-info] mode=${EXECUTE ? 'EXECUTE' : 'DRY-RUN'}`);
  const all = await fetchAllContacts(pit, locationId);
  console.log(`[no-contact-info] ${all.length} contacts fetched`);

  // Rule: delete any contact with no email AND no phone. Tags are
  // ignored intentionally — Clint's call (partial form submissions
  // can carry workflow tags but still be undeliverable).
  const victims = all.filter((c) => !hasContactInfo(c));
  console.log(`[no-contact-info] ${victims.length} contacts qualify for deletion`);

  const log = {
    started_at: new Date().toISOString(),
    mode: EXECUTE ? 'execute' : 'dry-run',
    fetched_total: all.length,
    deletions: [],
    failures: [],
  };

  for (const v of victims) {
    const name = `${v.firstName ?? ''} ${v.lastName ?? ''}`.trim() || '(no name)';
    if (!EXECUTE) {
      log.deletions.push({
        would_delete_contact_id: v.id,
        name,
        tags: v.tags || [],
      });
      continue;
    }
    try {
      await ghl('DELETE', pit, `/contacts/${v.id}`);
      log.deletions.push({
        deleted_contact_id: v.id,
        name,
        tags: v.tags || [],
        deleted_at: new Date().toISOString(),
      });
      if (log.deletions.length % 25 === 0) console.log(`  …deleted ${log.deletions.length}`);
    } catch (e) {
      log.failures.push({ contact_id: v.id, name, error: e.message });
    }
  }

  log.finished_at = new Date().toISOString();
  writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));

  console.log('\n──── Summary ────');
  console.log(`  Contacts fetched:     ${log.fetched_total}`);
  console.log(`  Qualify (no email + no phone): ${victims.length}`);
  console.log(`  ${EXECUTE ? 'Deleted' : 'Would delete'}:           ${log.deletions.length}`);
  console.log(`  Failures:             ${log.failures.length}`);
  console.log(`\n  Full log: ${LOG_PATH}`);
  if (!EXECUTE) console.log('\n  → Re-run with --execute to actually delete.');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => pool.end());
