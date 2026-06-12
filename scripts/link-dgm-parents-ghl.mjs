// Link every active DGM parent to a GHL contact (match by email,
// create when missing) and write the clean roster data back to GHL
// (firstName / lastName / phone — email is the match key, untouched).
//
// After this, parents.ghl_contact_id is populated for everyone, which
// is what the inbound contact webhook keys on — making "edit in GHL →
// dashboard updates" work for every family.
//
//   node scripts/link-dgm-parents-ghl.mjs            # dry-run
//   node scripts/link-dgm-parents-ghl.mjs --apply
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import pg from 'pg';
import axios from 'axios';

const SCHOOL_ID = 'cfa9030d-c8fe-49ae-a9e7-f1003844ec07';
const APPLY = process.argv.includes('--apply');

for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('='); if (eq < 0) continue;
  const k = t.slice(0, eq).trim();
  if (!process.env[k]) process.env[k] = t.slice(eq + 1).trim().replace(/^"|"$/g, '');
}
function decryptPit(ct, iv, tag) {
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(process.env.ENCRYPTION_KEY, 'base64'), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const e164 = (digits) => (digits && /^\d{11}$/.test(digits) && digits.startsWith('1') ? `+${digits}` : digits || null);

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const school = (await pool.query(`SELECT ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag FROM schools WHERE id=$1`, [SCHOOL_ID])).rows[0];
const gh = axios.create({
  baseURL: 'https://services.leadconnectorhq.com',
  headers: { Authorization: `Bearer ${decryptPit(school.ghl_pit_encrypted, school.ghl_pit_iv, school.ghl_pit_tag)}`, Version: '2021-07-28', Accept: 'application/json', 'Content-Type': 'application/json' },
  timeout: 30000,
});
const loc = school.ghl_location_id;

const parents = (await pool.query(
  `SELECT p.id, p.first_name, p.last_name, lower(p.email) email, p.phone, p.ghl_contact_id
     FROM parents p JOIN families f ON f.id = p.family_id
    WHERE p.school_id=$1 AND p.status='active' AND f.status='active' AND p.email IS NOT NULL
    ORDER BY p.last_name, p.first_name`,
  [SCHOOL_ID],
)).rows.filter((p) => !p.email.endsWith('@growthsuite.test')); // skip demo

const unlinked = parents.filter((p) => !p.ghl_contact_id);
console.log(`active parents w/ email: ${parents.length} · already linked: ${parents.length - unlinked.length} · to link: ${unlinked.length}`);
console.log(`mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}\n`);

async function findByEmail(email) {
  const { data } = await gh.post('/contacts/search', {
    locationId: loc, pageLimit: 5, page: 1,
    filters: [{ field: 'email', operator: 'eq', value: email }],
  });
  const list = data.contacts ?? [];
  return list.find((c) => (c.email ?? '').trim().toLowerCase() === email) ?? null;
}

let matched = 0, createdN = 0, linkFail = 0;
for (const p of unlinked) {
  try {
    let contact = await findByEmail(p.email);
    if (!contact && APPLY) {
      const { data } = await gh.post('/contacts/', {
        locationId: loc, firstName: p.first_name, lastName: p.last_name,
        email: p.email, ...(p.phone ? { phone: e164(p.phone) } : {}),
      });
      contact = data.contact;
      createdN++;
    } else if (!contact) {
      createdN++; // dry-run: would create
    } else {
      matched++;
    }
    if (APPLY && contact) {
      await pool.query(`UPDATE parents SET ghl_contact_id=$2, updated_at=now() WHERE id=$1`, [p.id, contact.id]);
    }
    await sleep(160);
  } catch (e) {
    linkFail++;
    console.warn(`  link FAIL ${p.first_name} ${p.last_name} <${p.email}>: ${e.response?.status ?? ''} ${e.message}`);
  }
}
console.log(`link pass: matched ${matched}, ${APPLY ? 'created' : 'would create'} ${createdN}, failed ${linkFail}`);

// ── writeback: clean names/phones to every linked contact ───────────
const linked = (await pool.query(
  `SELECT p.id, p.first_name, p.last_name, p.phone, p.ghl_contact_id
     FROM parents p JOIN families f ON f.id = p.family_id
    WHERE p.school_id=$1 AND p.status='active' AND f.status='active' AND p.ghl_contact_id IS NOT NULL
      AND p.email IS NOT NULL AND p.email NOT LIKE '%@growthsuite.test'`,
  [SCHOOL_ID],
)).rows;

let wrote = 0, wbFail = 0;
if (APPLY) {
  for (const p of linked) {
    try {
      const body = { firstName: p.first_name, lastName: p.last_name };
      const ph = e164(p.phone);
      if (ph) body.phone = ph;
      await gh.put(`/contacts/${p.ghl_contact_id}`, body);
      wrote++;
      await sleep(160);
    } catch (e) {
      wbFail++;
      if (wbFail <= 5) console.warn(`  writeback FAIL ${p.first_name} ${p.last_name}: ${e.response?.status ?? ''} ${e.message}`);
    }
  }
  console.log(`writeback: ${wrote} contacts updated (name/phone), ${wbFail} failed`);
} else {
  console.log(`writeback: would update ${linked.length} linked contacts (name/phone)`);
}

if (APPLY) {
  const after = (await pool.query(
    `SELECT COUNT(*) FILTER (WHERE ghl_contact_id IS NOT NULL)::int linked, COUNT(*)::int total
       FROM parents p JOIN families f ON f.id=p.family_id
      WHERE p.school_id=$1 AND p.status='active' AND f.status='active' AND p.email IS NOT NULL`,
    [SCHOOL_ID],
  )).rows[0];
  console.log(`\nfinal: ${after.linked}/${after.total} active parents GHL-linked`);
} else {
  console.log('\nDRY-RUN — nothing written. Re-run with --apply.');
}
await pool.end();
