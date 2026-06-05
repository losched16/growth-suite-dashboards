// One-off GHL probe for Peoria Montessori onboarding. Pulls:
//   1. Custom fields
//   2. Tags in use (from contact sample)
//   3. Total contact count
//   4. Sample contacts with tags + custom field values
//   5. Lists (smart lists / saved searches)
//
// No DB writes. Just prints what's at the location so we can decide
// how to identify "current parents" before importing.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(join(here, '..', '.env.local'), 'utf8');
for (const ln of envText.split(/\r?\n/)) {
  const m = ln.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (!m) continue;
  let v = m[2];
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  process.env[m[1]] = v;
}

const PIT = 'pit-416d7c9b-1166-4355-82d7-266cddd06a7c';
const LOCATION_ID = 'cucEbOulc74TXTdHgL89';
const BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';

async function ghl(path, opts = {}) {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const r = await fetch(url, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${PIT}`,
      'Version': VERSION,
      'Accept': 'application/json',
      ...(opts.headers ?? {}),
    },
  });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!r.ok) {
    console.error(`GHL ${r.status} ${path}:`, typeof body === 'string' ? body.slice(0, 400) : JSON.stringify(body).slice(0, 400));
    return null;
  }
  return body;
}

console.log('=== 1. Custom fields ===');
const cfRes = await ghl(`/locations/${LOCATION_ID}/customFields`);
const customFields = cfRes?.customFields ?? [];
console.log(`Total: ${customFields.length}`);
for (const f of customFields) {
  console.log(`  [${f.dataType ?? f.fieldType ?? '?'}] ${f.name}  fieldKey=${f.fieldKey}  model=${f.model ?? ''}`);
}

console.log('\n=== 2. Tags ===');
// GHL has /locations/{id}/tags
const tagsRes = await ghl(`/locations/${LOCATION_ID}/tags`);
const tags = tagsRes?.tags ?? [];
console.log(`Total: ${tags.length}`);
for (const t of tags) {
  console.log(`  ${t.name}  (id=${t.id})`);
}

console.log('\n=== 3. Custom values ===');
const cvRes = await ghl(`/locations/${LOCATION_ID}/customValues`);
const customValues = cvRes?.customValues ?? [];
console.log(`Total: ${customValues.length}`);
for (const v of customValues) {
  console.log(`  ${v.name} = ${typeof v.value === 'string' ? v.value.slice(0, 80) : v.value}`);
}

console.log('\n=== 4. Pipelines ===');
const plRes = await ghl(`/opportunities/pipelines?locationId=${LOCATION_ID}`);
const pipelines = plRes?.pipelines ?? [];
console.log(`Total: ${pipelines.length}`);
for (const p of pipelines) {
  console.log(`  ${p.name}  stages: ${(p.stages ?? []).map((s) => s.name).join(' → ')}`);
}

console.log('\n=== 5. Contacts — page 1 (limit 100) ===');
// GHL contacts use /contacts/search (POST) or /contacts/ (GET). Try GET first.
const cRes = await ghl(`/contacts/?locationId=${LOCATION_ID}&limit=100`);
const contacts = cRes?.contacts ?? [];
console.log(`Returned: ${contacts.length}  meta=${JSON.stringify(cRes?.meta ?? {})}`);

// Sample 5 contacts in detail
console.log('\n--- sample contacts (first 5) ---');
for (const c of contacts.slice(0, 5)) {
  console.log(`\n  ${c.firstName ?? ''} ${c.lastName ?? ''} <${c.email ?? ''}>  ph=${c.phone ?? ''}  id=${c.id}`);
  if (c.tags?.length) console.log(`    tags: ${c.tags.join(', ')}`);
  // pull full record to see custom field values
  const full = await ghl(`/contacts/${c.id}`);
  const cfVals = full?.contact?.customFields ?? [];
  for (const v of cfVals.slice(0, 12)) {
    const field = customFields.find((f) => f.id === v.id);
    const name = field?.name ?? v.id;
    let val = v.value;
    if (typeof val === 'string' && val.length > 80) val = val.slice(0, 80) + '…';
    console.log(`    cf: ${name} = ${JSON.stringify(val)}`);
  }
}

// Tag frequency analysis — useful for finding "current parent" patterns
console.log('\n--- tag frequency across page 1 (top 30) ---');
const tagCounts = new Map();
for (const c of contacts) {
  for (const t of (c.tags ?? [])) {
    tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  }
}
const sorted = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
for (const [t, n] of sorted) {
  console.log(`  ${n.toString().padStart(3, ' ')}x  ${t}`);
}

console.log('\nDone.');
