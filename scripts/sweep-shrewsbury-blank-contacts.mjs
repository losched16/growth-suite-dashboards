// Broad sweep: delete every Shrewsbury GHL contact that has NO email,
// NO phone, NO tags AS LONG AS at least one populated sibling exists
// with the same normalized (firstName + lastName).
//
// "Sibling" = another contact whose name matches ours after lowercasing
// + trimming + collapsing whitespace. We keep all populated rows;
// blanks evaporate.
//
// Edge case — pure orphan blanks (a blank contact with no populated
// twin) are NOT deleted in this pass. They're logged separately so
// Clint can decide whether they're junk or legitimate pending leads.
//
// Edge case — split data (Benoit-style: one contact has email only,
// another has phone only) is NOT auto-merged here. Both are kept,
// and the pair is logged so Clint can review later. Auto-merging
// runs into GHL's "no duplicate" rule and needs the same delete-
// first dance we coded for the Benoit case.
//
// Idempotent + logged.
//
// Usage:
//   node scripts/sweep-shrewsbury-blank-contacts.mjs            # dry-run
//   node scripts/sweep-shrewsbury-blank-contacts.mjs --execute  # really delete

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
const LOG_PATH = join(projectRoot, '..', `shrewsbury-sweep-log-${EXECUTE ? 'executed' : 'dryrun'}.json`);

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
  const pageLimit = 100;
  while (page <= 50) {
    const j = await ghl('POST', pit, '/contacts/search', { locationId, pageLimit, page });
    const contacts = j.contacts ?? [];
    all.push(...contacts);
    if (contacts.length < pageLimit) break;
    page++;
  }
  return all;
}

function normName(s) {
  return String(s ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
}
function nameKey(c) {
  return `${normName(c.firstName)}|${normName(c.lastName)}`;
}
function isBlank(c) {
  return (!c.email || c.email.trim() === '')
    && (!c.phone || c.phone.trim() === '')
    && (!c.tags  || c.tags.length === 0);
}
function isPopulated(c) {
  return !isBlank(c);
}

async function main() {
  const { pit, locationId } = await loadPit();
  console.log(`[sweep] mode=${EXECUTE ? 'EXECUTE' : 'DRY-RUN'}`);
  console.log('[sweep] fetching all Shrewsbury contacts…');
  const all = await fetchAllContacts(pit, locationId);
  console.log(`[sweep] ${all.length} contacts on file`);

  // Bucket by name key
  const byName = new Map();
  for (const c of all) {
    // Skip contacts with no name at all — those need human review,
    // they're not auto-deleteable.
    const k = nameKey(c);
    if (k === '|') continue;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(c);
  }

  const log = {
    started_at: new Date().toISOString(),
    mode: EXECUTE ? 'execute' : 'dry-run',
    fetched_total: all.length,
    distinct_names: byName.size,
    deletions: [],
    failures: [],
    pure_orphan_blanks: [],   // blanks with no populated sibling — flagged but not touched
    split_data_pairs: [],     // potential merges (email-only + phone-only) — flagged but not touched
  };

  for (const [key, group] of byName) {
    const blanks = group.filter(isBlank);
    const populated = group.filter(isPopulated);

    // Pure populated cluster — nothing to do
    if (blanks.length === 0) continue;

    // Pure orphan blank — flag, don't auto-delete
    if (populated.length === 0) {
      for (const c of blanks) {
        log.pure_orphan_blanks.push({
          ghl_contact_id: c.id,
          firstName: c.firstName,
          lastName: c.lastName,
          created: c.dateAdded,
        });
      }
      continue;
    }

    // Detect potential split-data merge candidates (Benoit-style:
    // one populated has email-only, another has phone-only). Flag for
    // separate review. We don't block the blank-shell delete on it.
    const emailOnly = populated.filter((c) => (c.email && c.email.trim()) && !(c.phone && c.phone.trim()));
    const phoneOnly = populated.filter((c) => (c.phone && c.phone.trim()) && !(c.email && c.email.trim()));
    if (emailOnly.length >= 1 && phoneOnly.length >= 1) {
      log.split_data_pairs.push({
        name_key: key,
        firstName: populated[0].firstName,
        lastName: populated[0].lastName,
        contacts: populated.map((c) => ({
          id: c.id, email: c.email || null, phone: c.phone || null, tags: c.tags || [],
        })),
      });
    }

    // Delete every blank sibling
    for (const victim of blanks) {
      if (!EXECUTE) {
        log.deletions.push({
          would_delete_contact_id: victim.id,
          name: `${victim.firstName ?? ''} ${victim.lastName ?? ''}`.trim(),
          populated_siblings: populated.length,
        });
        continue;
      }
      try {
        await ghl('DELETE', pit, `/contacts/${victim.id}`);
        log.deletions.push({
          deleted_contact_id: victim.id,
          name: `${victim.firstName ?? ''} ${victim.lastName ?? ''}`.trim(),
          deleted_at: new Date().toISOString(),
          populated_siblings: populated.length,
        });
        if (log.deletions.length % 25 === 0) console.log(`  …deleted ${log.deletions.length}`);
      } catch (e) {
        log.failures.push({
          contact_id: victim.id,
          name: `${victim.firstName ?? ''} ${victim.lastName ?? ''}`.trim(),
          error: e.message,
        });
      }
    }
  }

  log.finished_at = new Date().toISOString();
  writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));

  console.log('\n──── Summary ────');
  console.log(`  Contacts fetched:           ${log.fetched_total}`);
  console.log(`  Distinct names:             ${log.distinct_names}`);
  console.log(`  ${EXECUTE ? 'Deleted' : 'Would-delete'}:               ${log.deletions.length}`);
  console.log(`  Failures:                   ${log.failures.length}`);
  console.log(`  Pure orphan blanks (kept):  ${log.pure_orphan_blanks.length}`);
  console.log(`  Split-data pairs (flagged): ${log.split_data_pairs.length}`);
  console.log(`\n  Full log: ${LOG_PATH}`);
  if (!EXECUTE && log.deletions.length > 0) {
    console.log('\n  → Re-run with --execute to actually delete.');
  }
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => pool.end());
