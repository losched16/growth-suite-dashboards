// Clear Household ID from secondary-parent GHL contacts in Peoria.
//
// DGM-style pattern: ONE GHL contact per family = the primary parent.
// The spouse's data lives in Parent 2 First/Last/Email/Phone custom
// fields ON the primary's contact. The spouse may also have their own
// contact for email marketing purposes, but it must NOT have
// household_id set, otherwise the sync treats it as a second family.
//
// Setup-peoria-sync stamped household_id on BOTH spouses, creating 14
// duplicate families. This fixes that by clearing Household ID on the
// secondary of each couple.

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(join(here, '..', '.env.local'), 'utf8');
for (const ln of envText.split(/\r?\n/)) {
  const m = ln.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (!m) continue;
  let v = m[2]; if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  process.env[m[1]] = v;
}

const PIT = 'pit-416d7c9b-1166-4355-82d7-266cddd06a7c';
const LOCATION_ID = 'cucEbOulc74TXTdHgL89';
const BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';
const HOUSEHOLD_ID_FIELD = 'VCcL6te0wXwZaonZrZ2s';

const DL = 'C:\\Users\\thelo\\Downloads';

async function ghl(path, opts = {}) {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const r = await fetch(url, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${PIT}`,
      'Version': VERSION,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...(opts.headers ?? {}),
    },
  });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!r.ok) return { ok: false, status: r.status, body };
  return { ok: true, body };
}

function parseCsv(text) {
  const rows = []; let cur = []; let field = ''; let inQuote = false; let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (ch === '"') { inQuote = false; i++; continue; }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuote = true; i++; continue; }
    if (ch === ',') { cur.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; i++; continue; }
    field += ch; i++;
  }
  if (field !== '' || cur.length) { cur.push(field); rows.push(cur); }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0]));
}

// Re-cluster current parents by last name (same logic as setup-peoria-sync)
const cpText = readFileSync(join(DL, 'Current_parents_email.csv'), 'utf8');
const cpRows = parseCsv(cpText);
const header = cpRows[0].map((h) => h.toLowerCase().trim());
const emailIdx = header.findIndex((h) => h === 'email address');
const firstIdx = header.findIndex((h) => h === 'first name');
const lastIdx  = header.findIndex((h) => h === 'last name');
const tagsIdx  = header.findIndex((h) => h === 'tags');

const currentParents = [];
for (let r = 1; r < cpRows.length; r++) {
  const row = cpRows[r];
  if (!row || row.length < 2) continue;
  const email = (row[emailIdx] ?? '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
  const tagsRaw = tagsIdx >= 0 ? (row[tagsIdx] ?? '') : '';
  const isStaff = email.endsWith('@peoriamontessori.org') || tagsRaw.toLowerCase().includes('staff');
  if (isStaff) continue;
  currentParents.push({
    email,
    firstName: (row[firstIdx] ?? '').trim(),
    lastName:  (row[lastIdx]  ?? '').trim(),
  });
}

// Pull all GHL contacts
const all = [];
{
  let startAfter, startAfterId;
  for (let p = 0; p < 50; p++) {
    const body = { locationId: LOCATION_ID, pageLimit: 100 };
    if (startAfter && startAfterId) body.searchAfter = [startAfter, startAfterId];
    const r = await ghl('/contacts/search', { method: 'POST', body: JSON.stringify(body) });
    if (!r.ok) break;
    const list = r.body.contacts ?? [];
    if (!list.length) break;
    all.push(...list);
    const last = list[list.length - 1];
    startAfter = new Date(last.dateAdded).getTime();
    startAfterId = last.id;
    if (all.length >= (r.body.total ?? 0)) break;
  }
}
const contactByEmail = new Map();
for (const c of all) if (c.email) contactByEmail.set(c.email.toLowerCase(), c);

// Cluster
const byLast = new Map();
for (const p of currentParents) {
  const ln = (p.lastName || '').toLowerCase();
  if (!ln) continue;
  if (!byLast.has(ln)) byLast.set(ln, []);
  byLast.get(ln).push(p);
}

let clearedCount = 0;
for (const [_ln, members] of byLast) {
  if (members.length < 2) continue;
  // Pick primary by GHL-existence (matches setup-peoria-sync's pick)
  let primary = null;
  for (const m of members) if (contactByEmail.has(m.email)) { primary = m; break; }
  if (!primary) primary = members[0];
  // Clear household_id on every NON-primary member
  for (const m of members) {
    if (m.email === primary.email) continue;
    const ct = contactByEmail.get(m.email);
    if (!ct) continue;
    const u = await ghl(`/contacts/${ct.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        customFields: [{ id: HOUSEHOLD_ID_FIELD, value: '' }],
      }),
    });
    if (u.ok) {
      clearedCount++;
      console.log(`  cleared HH on ${m.firstName} ${m.lastName} <${m.email}>`);
    } else {
      console.error(`  FAIL clear ${ct.id}:`, u.body);
    }
  }
}

console.log(`\nCleared household_id on ${clearedCount} secondary contacts.`);
