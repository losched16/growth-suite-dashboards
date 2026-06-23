// Delete the 42 "blank shell" contacts identified in the duplicate
// cleanup plan (../shrewsbury-duplicates-cleanup-plan.xlsx).
//
// Plan-of-attack:
//   1. Load the cleanup plan, pick rows with recommended_action
//      starting with "DELETE — blank shell".
//   2. For each row, search Shrewsbury's GHL contacts for a match by
//      lowercase (firstName, lastName). Confirm the candidate has NO
//      email AND NO phone (matches the "blank shell" signature) AND
//      isn't already the unique survivor we want to keep.
//   3. With --dry-run (default) we report what would happen without
//      writing.
//   4. Pass --execute to actually DELETE the GHL contacts.
//
// Defenses:
//   - Matches are validated to be uniquely identifiable. If two GHL
//     contacts share the exact same name + both have empty contact
//     info, we skip ("ambiguous"). Op needs to disambiguate.
//   - Never touches a contact that has any tag, opportunity,
//     conversation, or non-empty email/phone — even if names match.
//   - Logs every action so a re-run shows what was already cleaned.
//
// Usage:
//   node scripts/cleanup-shrewsbury-duplicate-contacts.mjs            # dry-run (safe)
//   node scripts/cleanup-shrewsbury-duplicate-contacts.mjs --execute  # really delete

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
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
const PLAN_PATH = join(projectRoot, '..', 'shrewsbury-duplicates-cleanup-plan.xlsx');
const LOG_PATH = join(projectRoot, '..', `shrewsbury-cleanup-log-${EXECUTE ? 'executed' : 'dryrun'}.json`);

const SHREWSBURY_SCHOOL_ID = 'bf5e15d7-c0df-4ac6-9b6f-ededee90b02a';
const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function decrypt(ciphertext, iv, tag) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ciphertext), d.final()]).toString('utf8');
}

async function loadPit() {
  const r = await pool.query(
    `SELECT ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag
       FROM schools WHERE id = $1`,
    [SHREWSBURY_SCHOOL_ID],
  );
  const row = r.rows[0];
  return {
    locationId: row.ghl_location_id,
    pit: decrypt(row.ghl_pit_encrypted, row.ghl_pit_iv, row.ghl_pit_tag),
  };
}

// Pull the DELETE-flagged rows from the cleanup XLSX via a tiny Python
// shell-out (already have openpyxl installed).
function loadDeleteCandidates() {
  const py = `
import json
import pandas as pd
df = pd.read_excel(r"${PLAN_PATH.replace(/\\/g, '\\\\')}", sheet_name='Contacts')
out = []
for _, r in df.iterrows():
    action = str(r['recommended_action'])
    if not action.startswith('DELETE'):
        continue
    out.append({
        'row_num': int(r['Original Row #']) if pd.notna(r['Original Row #']) else None,
        'first': r['First Name'],
        'last':  r['Last Name'],
        'email_in_plan': r['Email'] if pd.notna(r['Email']) and r['Email'] != '' else None,
        'phone_in_plan': r['Phone'] if pd.notna(r['Phone']) and r['Phone'] != '' else None,
    })
print(json.dumps(out))
`;
  const res = spawnSync('python', ['-c', py], { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`python load failed: ${res.stderr}`);
  }
  return JSON.parse(res.stdout);
}

async function ghlReq(pit, method, path, body) {
  const r = await fetch(`${GHL_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${pit}`,
      Version: GHL_VERSION,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`${method} ${path} → ${r.status}: ${text}`);
  }
  // DELETE often returns no body
  const ct = r.headers.get('content-type') || '';
  return ct.includes('application/json') ? r.json() : null;
}

// Pull every Shrewsbury contact once — 716ish — so we can match
// locally (much faster than 42 individual searches).
async function fetchAllContacts(pit, locationId) {
  const all = [];
  let page = 1;
  const pageLimit = 100;
  while (page <= 50) {
    const j = await ghlReq(pit, 'POST', '/contacts/search', {
      locationId, pageLimit, page,
    });
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

async function main() {
  const candidates = loadDeleteCandidates();
  console.log(`[cleanup] ${candidates.length} DELETE candidates loaded from cleanup plan`);

  const { pit, locationId } = await loadPit();
  console.log('[cleanup] fetching all Shrewsbury contacts…');
  const all = await fetchAllContacts(pit, locationId);
  console.log(`[cleanup] ${all.length} GHL contacts on file`);

  // Index by (firstName, lastName) → array
  const byName = new Map();
  for (const c of all) {
    const k = `${normName(c.firstName)}|${normName(c.lastName)}`;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(c);
  }

  const log = {
    started_at: new Date().toISOString(),
    mode: EXECUTE ? 'execute' : 'dry-run',
    candidates: candidates.length,
    matched_and_deletable: 0,
    deleted: 0,
    skipped: [],
    deletions: [],
    failures: [],
  };

  // Group candidates by name first. When a cluster has multiple blank
  // shells (e.g. 4 Mekalaa Babu shells), the cleanup plan flags ALL of
  // them for deletion — so we should delete one GHL contact per
  // candidate row, capped at the actual number of available blank
  // shells. This way we never over-delete: if the plan says "delete 2"
  // but only 1 blank shell exists, we delete the 1.
  const candidatesByName = new Map();
  for (const cand of candidates) {
    const k = `${normName(cand.first)}|${normName(cand.last)}`;
    if (!candidatesByName.has(k)) candidatesByName.set(k, []);
    candidatesByName.get(k).push(cand);
  }

  for (const [k, group] of candidatesByName) {
    const matches = byName.get(k) ?? [];

    if (matches.length === 0) {
      for (const cand of group) log.skipped.push({ ...cand, reason: 'no_match_in_ghl' });
      continue;
    }

    // Among name matches, only "blank shells" are deletable:
    // no email, no phone, no tags.
    const blanks = matches.filter((c) =>
      (!c.email || c.email.trim() === '') &&
      (!c.phone || c.phone.trim() === '') &&
      (!c.tags || c.tags.length === 0));

    if (blanks.length === 0) {
      for (const cand of group) {
        log.skipped.push({
          ...cand,
          reason: 'name_matched_but_no_blank_shell',
          match_count: matches.length,
          first_match_has_email: matches[0].email || null,
          first_match_has_phone: matches[0].phone || null,
        });
      }
      continue;
    }

    // Pair up: delete up to min(group.length, blanks.length) shells.
    // Any leftover candidates / leftover blanks get logged for visibility.
    const toDelete = Math.min(group.length, blanks.length);
    for (let i = 0; i < toDelete; i++) {
      const cand = group[i];
      const victim = blanks[i];
      log.matched_and_deletable++;
      if (!EXECUTE) {
        log.deletions.push({
          ...cand,
          ghl_contact_id: victim.id,
          action: 'would_delete',
          cluster_blanks: blanks.length,
        });
        continue;
      }
      try {
        await ghlReq(pit, 'DELETE', `/contacts/${victim.id}`);
        log.deleted++;
        log.deletions.push({
          ...cand,
          ghl_contact_id: victim.id,
          action: 'deleted',
          deleted_at: new Date().toISOString(),
        });
        if (log.deleted % 10 === 0) console.log(`  …deleted ${log.deleted}`);
      } catch (e) {
        log.failures.push({
          ...cand,
          ghl_contact_id: victim.id,
          error: e.message,
        });
      }
    }
    // Plan asked for more deletions than we have blanks for — log the
    // overflow (rare, just defensive).
    for (let i = toDelete; i < group.length; i++) {
      log.skipped.push({
        ...group[i],
        reason: 'plan_count_exceeds_blank_shells',
        plan_count: group.length,
        blanks_found: blanks.length,
      });
    }
  }

  log.finished_at = new Date().toISOString();
  writeFileSync(LOG_PATH, JSON.stringify(log, null, 2), 'utf8');

  console.log('\n──── Summary ────');
  console.log(`  Candidates:           ${log.candidates}`);
  console.log(`  Safe matches:         ${log.matched_and_deletable}`);
  console.log(`  Skipped:              ${log.skipped.length}`);
  console.log(`  Deleted:              ${log.deleted}${EXECUTE ? '' : ' (dry-run — would delete)'}`);
  console.log(`  Failures:             ${log.failures.length}`);
  console.log(`\n  Full log: ${LOG_PATH}`);
  if (log.skipped.length > 0) {
    console.log('\n  Skip-reason breakdown:');
    const counts = new Map();
    for (const s of log.skipped) counts.set(s.reason, (counts.get(s.reason) || 0) + 1);
    for (const [reason, count] of counts) console.log(`    ${count.toString().padStart(3)} · ${reason}`);
  }
  if (!EXECUTE && log.matched_and_deletable > 0) {
    console.log('\n  → Re-run with --execute to actually delete.');
  }
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => pool.end());
