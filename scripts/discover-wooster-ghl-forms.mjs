// Discovery: ping Wooster's GHL location and report every native form
// + survey + submission count. Output guides the backfill mapping
// (which GHL form id maps to which portal_form_definitions slug).
//
// Read-only. Doesn't touch the DB beyond loading the school's PIT.
//
// Usage:
//   node scripts/discover-wooster-ghl-forms.mjs              # full report
//   node scripts/discover-wooster-ghl-forms.mjs --sample 1   # also dump one sample submission per form

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import axios from 'axios';
import crypto from 'node:crypto';

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

const SCHOOL_ID = process.env.SCHOOL_ID || '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
const DUMP_SAMPLE = process.argv.includes('--sample');

const GHL_BASE_URL = 'https://services.leadconnectorhq.com';
const GHL_VERSION  = '2021-07-28';

// AES-256-GCM decrypt — mirrors lib/crypto.ts so this script can run
// standalone without TS/loader gymnastics.
function decrypt(encrypted, iv, tag) {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error('ENCRYPTION_KEY env var missing');
  // lib/crypto.ts stores the key as base64 in env. Try base64 first, fall back to hex.
  let key = Buffer.from(raw, 'base64');
  if (key.length !== 32) key = Buffer.from(raw, 'hex');
  if (key.length !== 32) throw new Error(`ENCRYPTION_KEY decoded to ${key.length} bytes; need 32`);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return dec.toString('utf8');
}

function makeClient(school) {
  const pit = decrypt(school.ghl_pit_encrypted, school.ghl_pit_iv, school.ghl_pit_tag);
  return axios.create({
    baseURL: GHL_BASE_URL,
    headers: {
      Authorization: `Bearer ${pit}`,
      Version: GHL_VERSION,
      Accept: 'application/json',
    },
    timeout: 30_000,
  });
}

// GHL paginates with `skip` + `limit` (offset-based). Some endpoints
// have a max `limit` of 50.
async function listAllPaged(client, path, key, params) {
  const out = [];
  const LIMIT = 50;
  let skip = 0;
  while (true) {
    let data;
    try {
      ({ data } = await client.get(path, { params: { ...params, skip, limit: LIMIT } }));
    } catch (e) {
      const status = e.response?.status;
      const body = e.response?.data;
      console.error(`  ✗ ${path}?skip=${skip} → HTTP ${status}`, body ? JSON.stringify(body).slice(0, 200) : e.message);
      return out;
    }
    const batch = data?.[key] ?? [];
    if (batch.length === 0) break;
    out.push(...batch);
    if (batch.length < LIMIT) break;
    skip += batch.length;
    if (skip > 5000) break; // safety
  }
  return out;
}

async function main() {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const { rows: schoolRows } = await pool.query(
    `SELECT id, name, ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag
       FROM schools WHERE id = $1`,
    [SCHOOL_ID],
  );
  const school = schoolRows[0];
  if (!school) {
    console.error('School not found:', SCHOOL_ID);
    process.exit(1);
  }
  console.log(`School: ${school.name} (${school.ghl_location_id})\n`);

  const client = makeClient(school);
  const locationParam = { locationId: school.ghl_location_id };

  // ── Forms ───────────────────────────────────────────────────────
  console.log('=== FORMS ===');
  const forms = await listAllPaged(client, '/forms/', 'forms', locationParam);
  console.log(`Found ${forms.length} form${forms.length === 1 ? '' : 's'}:\n`);

  for (const f of forms) {
    // The forms/submissions endpoint uses different paging from the
    // forms list endpoint — it doesn't accept `skip` or `page`. We
    // pass just locationId + formId and accept whatever GHL returns.
    let subs = [];
    let total = null;
    try {
      const { data } = await client.get('/forms/submissions', {
        params: { ...locationParam, formId: f.id, limit: 50 },
      });
      subs = data?.submissions ?? [];
      total = data?.meta?.total ?? null;
    } catch (e) {
      const status = e.response?.status;
      console.error(`  ✗ submissions for ${f.name} → HTTP ${status} ${e.response?.data?.message ?? e.message}`);
    }
    console.log(`  ${(total ?? subs.length).toString().padStart(4)} submissions (sample loaded: ${subs.length}) · ${f.name} · id=${f.id}`);
    if (DUMP_SAMPLE && subs.length > 0) {
      const sample = subs[0];
      const fields = sample.others ?? sample.formData ?? sample;
      console.log(`    sample keys: ${Object.keys(fields).slice(0, 12).join(', ')}`);
      console.log(`    sample contactId: ${sample.contactId}`);
    }
  }

  // ── Surveys ──────────────────────────────────────────────────────
  console.log('\n=== SURVEYS ===');
  const surveys = await listAllPaged(client, '/surveys/', 'surveys', locationParam);
  console.log(`Found ${surveys.length} survey${surveys.length === 1 ? '' : 's'}:\n`);
  for (const s of surveys) {
    let subs = [];
    let total = null;
    try {
      const { data } = await client.get('/surveys/submissions', {
        params: { ...locationParam, surveyId: s.id, limit: 50 },
      });
      subs = data?.submissions ?? [];
      total = data?.meta?.total ?? null;
    } catch (e) {
      const status = e.response?.status;
      console.error(`  ✗ submissions for ${s.name} → HTTP ${status} ${e.response?.data?.message ?? e.message}`);
    }
    console.log(`  ${(total ?? subs.length).toString().padStart(4)} submissions (sample loaded: ${subs.length}) · ${s.name} · id=${s.id}`);
    if (DUMP_SAMPLE && subs.length > 0) {
      const sample = subs[0];
      const fields = sample.others ?? sample.formData ?? sample;
      console.log(`    sample keys: ${Object.keys(fields).slice(0, 12).join(', ')}`);
      console.log(`    sample contactId: ${sample.contactId}`);
    }
  }

  // ── Summary table for mapping ────────────────────────────────────
  console.log('\n=== Mapping draft (for import script) ===');
  console.log('Edit this and feed it into the backfill — left side is GHL form/survey name, right side is portal_form_definitions slug.');
  for (const f of forms) {
    console.log(`  '${f.name.replace(/'/g, "\\'")}' → '<portal_slug>',  // GHL form ${f.id}`);
  }
  for (const s of surveys) {
    console.log(`  '${s.name.replace(/'/g, "\\'")}' → '<portal_slug>',  // GHL survey ${s.id}`);
  }

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
