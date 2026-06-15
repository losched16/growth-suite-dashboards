// Write each family's co-parent into the PRIMARY contact's parent_2_*
// custom fields in Growth Suite. This is the correct place for a second
// guardian in DGM's schema — many co-parents share one email, so they
// can't be distinct email-keyed contacts. Recovers the co-parents the
// office flagged as "only 1 contact listed."
//
//   node scripts/writeback-coparents-ghl.mjs            # dry-run
//   node scripts/writeback-coparents-ghl.mjs --apply
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import pg from 'pg';
import axios from 'axios';

const SCHOOL_ID = 'cfa9030d-c8fe-49ae-a9e7-f1003844ec07';
const DEMO = 'cdf70975-b0a4-4f3a-8a34-2858bfffe750';
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
const e164 = (p) => { if (!p) return null; const d = String(p).replace(/\D/g, ''); return d.length === 10 ? `+1${d}` : d.length === 11 ? `+${d}` : null; };

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const school = (await pool.query(`SELECT ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag FROM schools WHERE id=$1`, [SCHOOL_ID])).rows[0];
const gh = axios.create({
  baseURL: 'https://services.leadconnectorhq.com',
  headers: { Authorization: `Bearer ${decryptPit(school.ghl_pit_encrypted, school.ghl_pit_iv, school.ghl_pit_tag)}`, Version: '2021-07-28', 'Content-Type': 'application/json' },
  timeout: 30000,
});

const cf = (await gh.get(`/locations/${school.ghl_location_id}/customFields`)).data;
const idByKey = new Map();
for (const f of cf.customFields ?? []) {
  const k = (f.fieldKey ?? '').replace(/^contact\./, '');
  if (k) idByKey.set(k, f.id);
}
const KEYS = { first: 'parent_2_first_name', last: 'parent_2_last_name', email: 'parent_2_email', phone: 'parent_2_phone' };

// Per family: primary (linked) contact + the co-parent (2nd active parent).
const fams = (await pool.query(`
  SELECT f.id AS family_id,
         pr.ghl_contact_id AS primary_contact,
         co.first_name, co.last_name, co.email, co.phone
    FROM families f
    JOIN LATERAL (
      SELECT ghl_contact_id FROM parents
       WHERE family_id = f.id AND status='active' AND is_primary=true AND ghl_contact_id IS NOT NULL LIMIT 1
    ) pr ON true
    JOIN LATERAL (
      SELECT first_name, last_name, email, phone FROM parents
       WHERE family_id = f.id AND status='active' AND is_primary=false
       ORDER BY created_at LIMIT 1
    ) co ON true
   WHERE f.school_id=$1 AND f.status='active' AND f.id<>$2`, [SCHOOL_ID, DEMO])).rows;

console.log(`co-parents to write: ${fams.length} · mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
let ok = 0, failed = 0;
for (const r of fams) {
  const customFields = [];
  const push = (key, val) => { const id = idByKey.get(key); if (id && val != null && String(val).trim() !== '') customFields.push({ id, field_value: String(val) }); };
  push(KEYS.first, r.first_name);
  push(KEYS.last, r.last_name);
  push(KEYS.email, r.email);
  push(KEYS.phone, e164(r.phone));
  if (!customFields.length) continue;
  if (!APPLY) { ok++; continue; }
  try { await gh.put(`/contacts/${r.primary_contact}`, { customFields }); ok++; await sleep(150); }
  catch (e) { failed++; if (failed <= 6) console.warn(`  FAIL ${r.first_name} ${r.last_name}: ${e.response?.status ?? ''} ${JSON.stringify(e.response?.data ?? {}).slice(0,120)}`); }
}
console.log(`${APPLY ? 'wrote' : 'would write'} parent_2 on ${ok} contacts, failed ${failed}`);
if (!APPLY) console.log('\nDRY-RUN — re-run with --apply.');
await pool.end();
