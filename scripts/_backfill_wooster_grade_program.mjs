// One-off backfill: pull program + current-grade-level for each Wooster
// student's primary slot from GHL and write into students.metadata WITHOUT
// touching the rest of the row. The full sync (sync-wooster-from-ghl.mjs)
// would DELETE+INSERT and orphan all the portal form submissions Rachel
// just made for Natalie, so we patch in-place instead.
//
// Idempotent: re-run safely; writes are conditional on a value being
// present in GHL.

import pg from 'pg';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

const env = readFileSync('.env.local', 'utf8');
const lines = Object.fromEntries(
  env.split('\n').filter(l => l.includes('=')).map(l => {
    const i = l.indexOf('=');
    return [l.slice(0, i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g, '')];
  })
);
const dbUrl = lines.DATABASE_URL;
const encKey = lines.ENCRYPTION_KEY;

function decrypt(ciphertext, iv, tag) {
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(encKey, 'base64'), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ciphertext, 'base64')), d.final()]).toString('utf8');
}

const c = new pg.Client({ connectionString: dbUrl });
await c.connect();

const sc = (await c.query(
  `SELECT id, ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag
   FROM schools WHERE name ILIKE '%wooster%' LIMIT 1`,
)).rows[0];
const pit = decrypt(sc.ghl_pit_encrypted, sc.ghl_pit_iv, sc.ghl_pit_tag);
const locationId = sc.ghl_location_id;

// Build a field key → id map
const cfRes = await fetch(`https://services.leadconnectorhq.com/locations/${locationId}/customFields`, {
  headers: { Authorization: `Bearer ${pit}`, Version: '2021-07-28', Accept: 'application/json' },
});
const cfData = await cfRes.json();
const idByKey = new Map();
for (const f of cfData.customFields ?? []) idByKey.set(f.fieldKey, f.id);
const programId = idByKey.get('contact.select_the_program_this_child_will_attend');
const gradeId   = idByKey.get('contact.what_is_your_childs_current_level');
console.log('program field id:', programId);
console.log('grade   field id:', gradeId);

// Fetch all enrolled contacts (paginated)
async function searchAll(tag) {
  const all = [];
  let searchAfter;
  while (true) {
    const body = {
      locationId,
      pageLimit: 500,
      filters: [{ field: 'tags', operator: 'contains', value: tag }],
    };
    if (searchAfter) body.searchAfter = searchAfter;
    const res = await fetch(`https://services.leadconnectorhq.com/contacts/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pit}`,
        Version: '2021-07-28',
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`search failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    const batch = data.contacts ?? [];
    all.push(...batch);
    if (batch.length < 500) break;
    searchAfter = batch[batch.length - 1].searchAfter;
    if (!searchAfter) break;
  }
  return all;
}

const contacts = await searchAll('enrolled - 26/27');
console.log(`pulled ${contacts.length} enrolled GHL contacts`);

// Map ghl_contact_id → { program, grade_level }
const byContact = new Map();
for (const ct of contacts) {
  const cf = ct.customFields ?? [];
  const program = cf.find((x) => x.id === programId)?.value ?? null;
  const grade   = cf.find((x) => x.id === gradeId)?.value ?? null;
  byContact.set(ct.id, { program, grade });
}

// Update slot-1 students for each Wooster family
const sIds = await c.query(
  `SELECT id, metadata
   FROM students
   WHERE school_id = $1 AND status = 'active'
     AND (metadata->>'slot')::int = 1`,
  [sc.id],
);
console.log(`updating ${sIds.rows.length} slot-1 students`);

let withProgram = 0, withGrade = 0, both = 0, neither = 0;
for (const s of sIds.rows) {
  const ghlId = s.metadata?.ghl_parent_contact_id;
  const got = ghlId ? byContact.get(ghlId) : null;
  const md = { ...(s.metadata ?? {}) };
  if (got?.program) { md.program = got.program; withProgram++; }
  if (got?.grade)   { md.grade_level = got.grade; withGrade++; }
  if (got?.program && got?.grade) both++;
  if (!got?.program && !got?.grade) neither++;
  await c.query(`UPDATE students SET metadata = $1::jsonb WHERE id = $2`, [JSON.stringify(md), s.id]);
}

console.log(`done. program=${withProgram}, grade=${withGrade}, both=${both}, neither=${neither}`);
await c.end();
