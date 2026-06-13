// Additive GHL attribute sync: pulls every contact's tags + custom
// fields + opportunities from GHL and builds the per-school filter
// catalog. Does NOT touch families/students/parents/enrollments, so a
// roster loaded another way is untouched.
//
// Populates: ghl_contact_tags, ghl_opportunities, school_filter_catalog
// (full refresh of those 3 derived tables for the school).
//
//   node scripts/sync-ghl-attributes.mjs <schoolId>
//   node scripts/sync-ghl-attributes.mjs <schoolId> --report   # no writes
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import pg from 'pg';
import axios from 'axios';

const SCHOOL_ID = process.argv[2];
const REPORT_ONLY = process.argv.includes('--report');
if (!SCHOOL_ID || SCHOOL_ID.startsWith('--')) { console.error('Usage: node sync-ghl-attributes.mjs <schoolId> [--report]'); process.exit(1); }

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
const valToStr = (v) => {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(valToStr).filter(Boolean).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v).trim();
};

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const school = (await pool.query(`SELECT name, ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag FROM schools WHERE id=$1`, [SCHOOL_ID])).rows[0];
if (!school) { console.error('school not found'); process.exit(1); }
const loc = school.ghl_location_id;
const gh = axios.create({
  baseURL: 'https://services.leadconnectorhq.com',
  headers: { Authorization: `Bearer ${decryptPit(school.ghl_pit_encrypted, school.ghl_pit_iv, school.ghl_pit_tag)}`, Version: '2021-07-28', Accept: 'application/json', 'Content-Type': 'application/json' },
  timeout: 30000,
});
console.log(`Syncing GHL attributes for ${school.name} (${loc})${REPORT_ONLY ? ' [REPORT ONLY]' : ''}`);

// ── 1. custom-field definitions (id → key/label/type) ───────────────
const cfDefs = new Map();
{
  const { data } = await gh.get(`/locations/${loc}/customFields`);
  for (const f of data.customFields ?? []) {
    const key = (f.fieldKey ?? '').replace(/^contact\./, '');
    if (key) cfDefs.set(f.id, { key, label: f.name ?? key, dataType: f.dataType ?? 'TEXT', options: f.picklistOptions ?? [] });
  }
  console.log(`  custom-field defs: ${cfDefs.size}`);
}

// ── 2. all contacts (tags + custom-field values) ────────────────────
const contacts = [];
{
  let page = 1;
  while (page <= 100) {
    const { data } = await gh.post('/contacts/search', { locationId: loc, pageLimit: 100, page });
    const batch = data.contacts ?? [];
    contacts.push(...batch);
    if (batch.length < 100) break;
    page++; await sleep(120);
  }
  console.log(`  contacts: ${contacts.length}`);
}

// ── 3. pipelines + opportunities ────────────────────────────────────
const pipelineName = new Map();
const stageName = new Map();
try {
  const { data } = await gh.get('/opportunities/pipelines', { params: { locationId: loc } });
  for (const p of data.pipelines ?? []) {
    pipelineName.set(p.id, p.name);
    for (const st of p.stages ?? []) stageName.set(st.id, st.name);
  }
} catch (e) { console.warn('  pipelines fetch failed:', e.response?.status ?? e.message); }

const opps = [];
try {
  let startAfter, startAfterId, guard = 0;
  while (guard++ < 200) {
    const params = { location_id: loc, limit: 100 };
    if (startAfter) { params.startAfter = startAfter; params.startAfterId = startAfterId; }
    const { data } = await gh.get('/opportunities/search', { params });
    const batch = data.opportunities ?? [];
    opps.push(...batch);
    const meta = data.meta ?? {};
    if (batch.length < 100 || !meta.startAfterId) break;
    startAfter = meta.startAfter; startAfterId = meta.startAfterId; await sleep(120);
  }
  console.log(`  opportunities: ${opps.length}`);
} catch (e) { console.warn('  opportunities fetch failed:', e.response?.status ?? e.message); }

// ── 4. build catalog in memory ──────────────────────────────────────
const tagCounts = new Map();          // tag -> count
const cfValues = new Map();           // cf key -> { def, values:Set, count }
const stageSet = new Set();
const statusSet = new Set();
const pipeSet = new Set();

const tagRows = [];
const cfvRows = [];   // [contact_id, field_key, value]
for (const ct of contacts) {
  for (const tg of ct.tags ?? []) {
    const t = valToStr(tg); if (!t) continue;
    tagRows.push([SCHOOL_ID, ct.id, t]);
    tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  }
  for (const cf of ct.customFields ?? []) {
    const def = cfDefs.get(cf.id); if (!def) continue;
    const v = valToStr(cf.value); if (!v) continue;
    cfvRows.push([ct.id, def.key, v.slice(0, 2000)]);
    let entry = cfValues.get(def.key);
    if (!entry) { entry = { def, values: new Set(), count: 0 }; cfValues.set(def.key, entry); }
    entry.count++;
    if (entry.values.size < 200) entry.values.add(v);
  }
}
for (const o of opps) {
  if (o.pipelineId && pipelineName.has(o.pipelineId)) pipeSet.add(pipelineName.get(o.pipelineId));
  const sn = o.stageName ?? stageName.get(o.pipelineStageId);
  if (sn) stageSet.add(sn);
  if (o.status) statusSet.add(o.status);
}

function inferType(def, values) {
  const dt = (def.dataType || '').toUpperCase();
  if (dt.includes('OPTION')) return 'select';
  if (dt.includes('NUMER') || dt.includes('MONET')) return 'number';
  if (dt.includes('DATE')) return 'date';
  const arr = [...values];
  if (arr.length && arr.every((v) => /^-?\d+(\.\d+)?$/.test(v))) return 'number';
  if (arr.length && arr.length <= 40) return 'select';
  return 'text';
}

// ── 5. persist ──────────────────────────────────────────────────────
console.log(`\n  → ${tagCounts.size} distinct tags, ${cfValues.size} custom fields with data, ${stageSet.size} pipeline stages, ${statusSet.size} opp statuses`);
if (REPORT_ONLY) {
  console.log('  top tags:', [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([t, n]) => `${t}(${n})`).join(', '));
  console.log('  stages:', [...stageSet].join(', '));
  await pool.end();
  console.log('\nREPORT ONLY — nothing written.');
  process.exit(0);
}

const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('DELETE FROM ghl_contact_tags WHERE school_id=$1', [SCHOOL_ID]);
  await client.query('DELETE FROM ghl_contact_field_values WHERE school_id=$1', [SCHOOL_ID]);
  await client.query('DELETE FROM ghl_opportunities WHERE school_id=$1', [SCHOOL_ID]);
  await client.query('DELETE FROM school_filter_catalog WHERE school_id=$1', [SCHOOL_ID]);

  // tags
  for (let i = 0; i < tagRows.length; i += 500) {
    const chunk = tagRows.slice(i, i + 500);
    const vals = chunk.map((_, j) => `($${j*3+1},$${j*3+2},$${j*3+3})`).join(',');
    await client.query(`INSERT INTO ghl_contact_tags (school_id, ghl_contact_id, tag) VALUES ${vals} ON CONFLICT DO NOTHING`, chunk.flat());
  }
  // per-contact custom-field values
  for (let i = 0; i < cfvRows.length; i += 300) {
    const chunk = cfvRows.slice(i, i + 300);
    const vals = chunk.map((_, j) => `($1,$${j*3+2},$${j*3+3},$${j*3+4})`).join(',');
    await client.query(
      `INSERT INTO ghl_contact_field_values (school_id, ghl_contact_id, field_key, value) VALUES ${vals}
       ON CONFLICT (school_id, ghl_contact_id, field_key) DO UPDATE SET value=EXCLUDED.value, synced_at=now()`,
      [SCHOOL_ID, ...chunk.flat()],
    );
  }
  // opportunities
  for (const o of opps) {
    await client.query(
      `INSERT INTO ghl_opportunities (id, school_id, ghl_contact_id, pipeline_id, pipeline_name, stage_id, stage_name, status, monetary_value, last_stage_change_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET stage_name=EXCLUDED.stage_name, status=EXCLUDED.status, monetary_value=EXCLUDED.monetary_value, synced_at=now()`,
      [o.id, SCHOOL_ID, o.contactId ?? null, o.pipelineId ?? null, pipelineName.get(o.pipelineId) ?? null,
       o.pipelineStageId ?? null, o.stageName ?? stageName.get(o.pipelineStageId) ?? null, o.status ?? null,
       o.monetaryValue ?? null, o.lastStageChangeAt ?? null],
    );
  }
  // catalog: tags (single multi attr)
  const catalog = [];
  if (tagCounts.size) catalog.push(['tag', 'tag', 'Tags', null, 'multi', JSON.stringify([...tagCounts.keys()].sort()), tagRows.length]);
  // custom fields
  for (const [key, e] of cfValues) {
    const type = inferType(e.def, e.values);
    const samples = (type === 'select') ? [...e.values].sort() : [...e.values].slice(0, 20);
    catalog.push([`cf:${key}`, 'custom_field', e.def.label, e.def.id, type, JSON.stringify(samples), e.count]);
  }
  // opportunities
  if (stageSet.size) catalog.push(['opp_stage', 'opportunity_stage', 'Opportunity stage', null, 'select', JSON.stringify([...stageSet].sort()), opps.length]);
  if (statusSet.size) catalog.push(['opp_status', 'opportunity_status', 'Opportunity status', null, 'select', JSON.stringify([...statusSet].sort()), opps.length]);
  if (pipeSet.size) catalog.push(['pipeline', 'pipeline', 'Pipeline', null, 'select', JSON.stringify([...pipeSet].sort()), opps.length]);

  // FACTS billing attrs (mirrors lib/sync/ghl-attributes.ts — this
  // script rebuilds the catalog wholesale, so it must re-register them
  // or a manual run would wipe the FACTS filters).
  try {
    const { rows: factsRows } = await client.query(
      `SELECT charges, credits, total_charges_cents, total_credits_cents,
              net_charges_cents, payments_cents, credits_applied_cents, remaining_balance_cents
         FROM facts_transactions WHERE school_id = $1 AND student_id IS NOT NULL`, [SCHOOL_ID]);
    const counts = new Map();
    const bump = (k, v) => { if (Number(v)) counts.set(k, (counts.get(k) ?? 0) + 1); };
    for (const r of factsRows) {
      for (const [k, v] of Object.entries(r.charges ?? {})) bump(k, v);
      for (const [k, v] of Object.entries(r.credits ?? {})) bump(k, v);
      bump('total_charges', r.total_charges_cents);
      bump('total_credits', r.total_credits_cents);
      bump('net_charges', r.net_charges_cents);
      bump('payments', r.payments_cents);
      bump('credits_applied', r.credits_applied_cents);
      bump('remaining_balance', r.remaining_balance_cents);
    }
    const human = (k) => { const t = k.replace(/_/g, ' '); return t.charAt(0).toUpperCase() + t.slice(1); };
    for (const [k, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      catalog.push([`facts:${k}`, 'facts', `${human(k)} (FACTS)`, null, 'number', JSON.stringify([]), n]);
    }
  } catch (e) {
    console.warn('facts catalog skipped:', e.message);
  }

  for (const row of catalog) {
    await client.query(
      `INSERT INTO school_filter_catalog (school_id, attr_key, attr_type, label, ghl_field_id, data_type, sample_values, value_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
      [SCHOOL_ID, ...row],
    );
  }
  await client.query('COMMIT');
  console.log(`\nWROTE: ${tagRows.length} tag rows, ${cfvRows.length} field values, ${opps.length} opportunities, ${catalog.length} catalog attributes.`);
} catch (e) {
  await client.query('ROLLBACK');
  console.error('FAILED, rolled back:', e.message);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
