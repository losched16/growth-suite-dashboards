// NLMA GHL link-up: fetch every contact in NLMA's GHL workspace and
// match it to the parents we just imported from the CSV. On match,
// stamp parents.ghl_contact_id so the Family Hub / dashboards can
// deep-link back to GHL ("Open in CRM" buttons).
//
// Unlike sync-wooster-from-ghl.mjs, this does NOT rebuild the
// family-graph from GHL — NLMA's source of truth is the CSV import.
// We're just adding the GHL cross-reference.
//
// Match strategy (in order):
//   1. exact email match (case-insensitive)
//   2. last-7-digit phone match (handles +1, (), -, spaces variance)
//   3. unmatched contacts get logged; unmatched DB parents likewise
//
// Usage:
//   node scripts/sync-nlma-from-ghl.mjs                       # dry-run
//   node scripts/sync-nlma-from-ghl.mjs --apply               # link existing matches
//   node scripts/sync-nlma-from-ghl.mjs --apply --push        # also create GHL contacts for unmatched parents
//
// First-time onboarding flow (NLMA's case, GHL workspace empty):
//   --apply --push  → creates a fresh GHL contact for every parent
//                     who doesn't already match. The new contact's id
//                     gets stamped back onto parents.ghl_contact_id
//                     so the "Open in GHL" deep-links work.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

const envText = readFileSync(join(projectRoot, '.env.local'), 'utf8');
for (const line of envText.split('\n')) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('='); if (eq === -1) continue;
  const k = t.slice(0, eq).trim();
  if (!process.env[k]) process.env[k] = t.slice(eq + 1).trim();
}

const APPLY = process.argv.includes('--apply');
const PUSH  = process.argv.includes('--push');
const NLMA_SCHOOL_ID = '2717d71b-aa80-4ca0-8a13-e81cace2d9c1';

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── decrypt PIT ─────────────────────────────────────────────────────
function decrypt(ciphertext, iv, tag) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

async function loadPit() {
  const r = await pool.query(
    `SELECT ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag
     FROM schools WHERE id = $1`,
    [NLMA_SCHOOL_ID],
  );
  if (r.rowCount === 0) throw new Error('NLMA school row not found');
  const row = r.rows[0];
  return {
    locationId: row.ghl_location_id,
    pit: decrypt(row.ghl_pit_encrypted, row.ghl_pit_iv, row.ghl_pit_tag),
  };
}

// ── fetch all contacts via paginated search ─────────────────────────
async function fetchAllContacts(pit, locationId) {
  const all = [];
  let page = 1;
  const pageLimit = 100;
  while (page <= 100) {
    const res = await fetch(`${GHL_BASE}/contacts/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pit}`,
        Version: GHL_VERSION,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      // No filters → fetch every contact in the location.
      body: JSON.stringify({ locationId, pageLimit, page }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`contacts/search page ${page} failed: ${res.status} ${t}`);
    }
    const data = await res.json();
    const contacts = data.contacts ?? [];
    all.push(...contacts);
    process.stdout.write(`  page ${page}: +${contacts.length} (total ${all.length})\r`);
    if (contacts.length < pageLimit) break;
    page++;
  }
  console.log('');
  return all;
}

// ── matching helpers ────────────────────────────────────────────────
function last7(p) {
  if (!p) return null;
  const d = String(p).replace(/\D/g, '');
  if (d.length < 7) return null;
  return d.slice(-7);
}

// Push a single parent INTO GHL as a new contact. Returns the new
// contact id. Sets a "Source: NLMA roster import" tag so the school
// can audit which contacts came from this seed later.
async function createGhlContact(pit, locationId, parent, familyDisplayName) {
  const body = {
    locationId,
    firstName: parent.first_name ?? '',
    lastName:  parent.last_name  ?? '',
    name:      [parent.first_name, parent.last_name].filter(Boolean).join(' ') || 'Parent',
    email:     parent.email || undefined,
    phone:     parent.phone || undefined,
    tags:      ['nlma-roster-import', 'parent', familyDisplayName ? `family:${familyDisplayName}` : undefined].filter(Boolean),
    source:    'Growth Suite — NLMA roster import',
  };
  // Strip undefined keys so GHL doesn't complain about explicit nulls.
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  const res = await fetch(`${GHL_BASE}/contacts/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${pit}`,
      Version: GHL_VERSION,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    // GHL returns 400 with `meta.contactId` when a contact already
    // exists with the same email/phone — extract and reuse that id.
    try {
      const j = JSON.parse(t);
      const dupId = j?.meta?.contactId;
      if (res.status === 400 && dupId) return { id: dupId, deduped: true };
    } catch { /* ignore */ }
    throw new Error(`contacts POST failed for ${parent.first_name} ${parent.last_name}: ${res.status} ${t}`);
  }
  const data = await res.json();
  return { id: data.contact?.id ?? data.id, deduped: false };
}

// ── main ────────────────────────────────────────────────────────────
async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN (no writes)'}`);
  console.log(`School: Northern Lights Montessori (${NLMA_SCHOOL_ID})\n`);

  const { pit, locationId } = await loadPit();
  console.log(`Using GHL location ${locationId}`);

  console.log('\nFetching GHL contacts (paginated)…');
  const ghlContacts = await fetchAllContacts(pit, locationId);
  console.log(`Total GHL contacts: ${ghlContacts.length}`);

  // Build email + phone indexes
  const byEmail = new Map();
  const byPhone7 = new Map();
  for (const c of ghlContacts) {
    const email = (c.email || '').trim().toLowerCase();
    if (email) {
      if (!byEmail.has(email)) byEmail.set(email, []);
      byEmail.get(email).push(c);
    }
    const p = last7(c.phone);
    if (p) {
      if (!byPhone7.has(p)) byPhone7.set(p, []);
      byPhone7.get(p).push(c);
    }
  }

  // Load our NLMA parents + their family display names (used as a
  // tag on the GHL contact so the school can group siblings later).
  const { rows: parents } = await pool.query(
    `SELECT p.id, p.first_name, p.last_name, p.email, p.phone, p.ghl_contact_id,
            f.display_name AS family_display_name
       FROM parents p
       JOIN families f ON f.id = p.family_id
      WHERE p.school_id = $1
      ORDER BY p.last_name, p.first_name`,
    [NLMA_SCHOOL_ID],
  );
  console.log(`Total NLMA parents in DB: ${parents.length}`);

  // Match
  const matches = [];
  const noMatch = [];
  const usedContactIds = new Set();
  for (const p of parents) {
    const e = (p.email || '').toLowerCase();
    const ph = last7(p.phone);
    let candidates = (e && byEmail.get(e)) || (ph && byPhone7.get(ph)) || [];
    // Filter out already-used contact ids so two parents don't both
    // claim the same GHL record (rare but possible — two parents at
    // the same household sharing an email).
    candidates = candidates.filter((c) => !usedContactIds.has(c.id));
    if (candidates.length === 0) {
      noMatch.push(p);
    } else {
      // Prefer the candidate whose first+last name also matches.
      const ranked = candidates.map((c) => {
        const ghlFirst = (c.firstName || '').toLowerCase();
        const ghlLast = (c.lastName || '').toLowerCase();
        const ourFirst = (p.first_name || '').toLowerCase();
        const ourLast = (p.last_name || '').toLowerCase();
        let score = 0;
        if (ghlFirst && ourFirst && ghlFirst === ourFirst) score += 2;
        if (ghlLast && ourLast && ghlLast === ourLast) score += 1;
        return { c, score };
      }).sort((a, b) => b.score - a.score);
      const top = ranked[0].c;
      usedContactIds.add(top.id);
      matches.push({ parent: p, contact: top, matchedBy: byEmail.get(e)?.includes(top) ? 'email' : 'phone' });
    }
  }

  console.log(`\nMatches: ${matches.length} / ${parents.length}`);
  for (const m of matches) {
    console.log(`  ✓ ${(m.parent.first_name + ' ' + (m.parent.last_name || '')).padEnd(28)} → ${m.contact.id}  [by ${m.matchedBy}]`);
  }

  if (noMatch.length > 0) {
    console.log(`\nNo GHL match (${noMatch.length}):`);
    for (const p of noMatch) {
      console.log(`  ✗ ${(p.first_name + ' ' + (p.last_name || '')).padEnd(28)}  email=${p.email ?? '—'}  phone=${p.phone ?? '—'}`);
    }
  }

  // Contacts that didn't get matched to any DB parent — surface for
  // visibility but don't touch them.
  const unusedContacts = ghlContacts.filter((c) => !usedContactIds.has(c.id));
  console.log(`\nGHL contacts with no matching DB parent: ${unusedContacts.length} (left alone)`);

  if (!APPLY) {
    console.log(`\n  (dry-run — re-run with --apply to commit ghl_contact_id updates`);
    if (PUSH) console.log(`           --push will create new GHL contacts for the ${noMatch.length} unmatched parents)`);
    else if (noMatch.length > 0) console.log(`           add --push to also create GHL contacts for the ${noMatch.length} unmatched parents)`);
    else console.log(`           )`);
    await pool.end();
    return;
  }

  // Existing matches get stamped first.
  console.log('\nWriting ghl_contact_id updates for matches…');
  let updated = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const m of matches) {
      const r = await client.query(
        `UPDATE parents SET ghl_contact_id = $1, updated_at = now()
          WHERE id = $2 AND school_id = $3 AND (ghl_contact_id IS NULL OR ghl_contact_id <> $1)`,
        [m.contact.id, m.parent.id, NLMA_SCHOOL_ID],
      );
      updated += r.rowCount;
    }
    await client.query('COMMIT');
    console.log(`  Matches committed. ${updated} parents linked to GHL.`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('  Match commit failed (rolled back):', e);
    throw e;
  } finally {
    client.release();
  }

  // Optional second pass: push parents that have no GHL counterpart
  // into GHL as fresh contacts, then stamp the new id back.
  if (PUSH && noMatch.length > 0) {
    console.log(`\nPushing ${noMatch.length} unmatched parents into GHL as new contacts…`);
    let pushed = 0, dedupedHits = 0, failed = 0;
    for (const p of noMatch) {
      try {
        const { id: newId, deduped } = await createGhlContact(pit, locationId, p, p.family_display_name);
        const c2 = await pool.connect();
        try {
          await c2.query(
            `UPDATE parents SET ghl_contact_id = $1, updated_at = now()
              WHERE id = $2 AND school_id = $3`,
            [newId, p.id, NLMA_SCHOOL_ID],
          );
        } finally { c2.release(); }
        pushed++;
        if (deduped) dedupedHits++;
        console.log(`  + ${(p.first_name + ' ' + (p.last_name || '')).padEnd(28)} → ${newId}${deduped ? ' (reused existing GHL dup)' : ''}`);
      } catch (e) {
        failed++;
        console.log(`  ✗ ${(p.first_name + ' ' + (p.last_name || '')).padEnd(28)} — ${e.message}`);
      }
    }
    console.log(`\n  Push done. ${pushed} created${dedupedHits > 0 ? ` (${dedupedHits} reused dups)` : ''}, ${failed} failed.`);
  }

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
