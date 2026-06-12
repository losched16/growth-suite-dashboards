// Shrewsbury Montessori — admissions CSV export for the CFO.
//
// Pulls all GHL contacts + all opportunities in the Admissions Pipeline,
// resolves each contact's custom fields (Parent 1 + Parent 2 + Student
// 1/2/3 info), and writes a wide CSV with a duplicate-detection flag.
//
// Duplicate detection passes through three lenses; any hit flags the
// row:
//   - same primary email (case/whitespace normalized)
//   - same primary phone (last 10 digits)
//   - same Parent 1 first+last (lowercased)
// The "dup_with_contacts" column lists the GHL contact ids it
// matches so the CFO can review side-by-side.
//
// Output: out/shrewsbury-admissions-<YYYY-MM-DD>.csv (relative to repo).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
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
  if (!process.env[t.slice(0, eq).trim()]) process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
}

const SHREWSBURY_SCHOOL_ID = 'bf5e15d7-c0df-4ac6-9b6f-ededee90b02a';
const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

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
  if (r.rowCount === 0) throw new Error('Shrewsbury school row not found');
  const row = r.rows[0];
  return {
    locationId: row.ghl_location_id,
    pit: decrypt(row.ghl_pit_encrypted, row.ghl_pit_iv, row.ghl_pit_tag),
  };
}

// Custom-field keys we want pulled per contact. Each entry: GHL fieldKey
// (without the "contact." prefix) → output column name.
const FIELDS_TO_PULL = {
  // Parent 1 / Guardian 1 (most contacts use this naming)
  parent1_first_name:     ['parent1_first_name', 'parent_first_name'],
  parent1_last_name:      ['parent_last_name'],
  parent1_email:          ['parentguardian_1_email'],
  parent1_phone:          ['parentguardian_1_phone'],
  parent1_gender:         ['parentguardian_gender'],
  parent1_relationship:   ['relationship_to_student'],

  // Parent 2 / Guardian 2
  parent2_first_name:     ['parent_2_first_name'],
  parent2_last_name:      ['parent_2_last_name'],
  parent2_email:          ['parent_2_email', 'parent_2_guardian_email'],
  parent2_phone:          ['parent_2_phone', 'parentguardian_2_phone'],
  parent2_relationship:   ['parent_2_relationshio_to_student'],

  // Student 1 (the main applicant)
  student1_first_name:    ['student_first_name'],
  student1_last_name:     ['student_last_name'],
  student1_dob:           ['student_date_of_birth'],
  student1_gender:        ['gender'],
  student1_grade:         ['grade_level_of_interest'],
  student1_year_of_entry: ['year_of_entry'],
  student1_program:       ['programs_of_interest'],
  student1_financial_aid: ['student_1_financial_aid'],

  // Student 2
  student2_first_name:    ['student_2_first_name'],
  student2_last_name:     ['student_2_last_name'],
  student2_grade:         ['grade_level_of_interest_student_2'],
  student2_financial_aid: ['student_2_financial_aid'],

  // Student 3
  student3_first_name:    ['student_3_first_name'],
  student3_last_name:     ['student_3_last_name'],
  student3_grade:         ['student_3_grade_level_of_interest_student_3'],
  student3_year_of_entry: ['student_3_year_of_entry'],
  student3_financial_aid: ['student_3_financial_aid'],

  // Admissions / pipeline meta
  enrollment_status:      ['enrollment_status_name'],
  admissions_status:      ['admissions_status_name'],
  applying_for:           ['applying_for'],
  campus_applying_for:    ['campus_applying_for'],
  current_school:         ['current_school_name'],
  app_submitted_date:     ['admissions_application_submitted_date'],
  app_accepted_date:      ['admissions_application_accepted_date'],
  app_declined_date:      ['admissions_application_declined_date'],
  enrollment_start_date:  ['enrollment_start_date'],
  admissions_total_fees:  ['admissions_total_fees'],
};

async function fetchAllContacts(pit, locationId) {
  const all = [];
  let page = 1;
  const pageLimit = 100;
  while (page <= 50) {
    const res = await fetch(`${GHL_BASE}/contacts/search`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pit}`, Version: GHL_VERSION, 'Content-Type': 'application/json' },
      body: JSON.stringify({ locationId, pageLimit, page }),
    });
    if (!res.ok) throw new Error(`contacts/search page ${page}: ${res.status} ${await res.text()}`);
    const data = await res.json();
    const contacts = data.contacts ?? [];
    all.push(...contacts);
    if (contacts.length < pageLimit) break;
    page++;
  }
  return all;
}

async function fetchAllOpportunities(pit, locationId) {
  const all = [];
  let page = 1;
  const pageLimit = 100;
  while (page <= 50) {
    const res = await fetch(
      `${GHL_BASE}/opportunities/search?location_id=${encodeURIComponent(locationId)}&limit=${pageLimit}&page=${page}`,
      { headers: { Authorization: `Bearer ${pit}`, Version: GHL_VERSION } },
    );
    if (!res.ok) {
      // Some PITs don't include opportunities scope — degrade gracefully.
      console.warn(`[warn] opportunities/search page ${page}: ${res.status}`);
      return all;
    }
    const data = await res.json();
    const opps = data.opportunities ?? [];
    all.push(...opps);
    if (opps.length < pageLimit) break;
    page++;
  }
  return all;
}

// Resolve a single contact's custom field by trying each fallback key.
// Returns the first non-empty value found.
function valueOf(contact, fieldIdsByKey, candidates) {
  for (const key of candidates) {
    const id = fieldIdsByKey.get(key);
    if (!id) continue;
    const hit = (contact.customFields || []).find((cf) => cf.id === id);
    if (hit?.value != null && String(hit.value).trim() !== '') {
      return String(hit.value).trim();
    }
  }
  return '';
}

function normEmail(e) {
  return (e || '').toLowerCase().trim();
}
function normPhone(p) {
  return (p || '').replace(/\D/g, '').slice(-10);
}
function normName(f, l) {
  return `${(f || '').toLowerCase().trim()} ${(l || '').toLowerCase().trim()}`.trim();
}

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (s === '') return '';
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function ymd(d = new Date()) {
  // Note: shell time. We can't import a clock-free date in workflow
  // scripts here so this is fine — it's a CSV filename suffix only.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function main() {
  const { pit, locationId } = await loadPit();
  console.log(`[shrewsbury-export] location ${locationId}`);

  console.log('[shrewsbury-export] fetching custom field schema…');
  const cfRes = await fetch(`${GHL_BASE}/locations/${locationId}/customFields`, {
    headers: { Authorization: `Bearer ${pit}`, Version: GHL_VERSION },
  });
  const cfData = await cfRes.json();
  const fieldIdsByKey = new Map();
  for (const f of cfData.customFields ?? []) {
    fieldIdsByKey.set((f.fieldKey || '').replace(/^contact\./, ''), f.id);
  }

  console.log('[shrewsbury-export] fetching contacts…');
  const contacts = await fetchAllContacts(pit, locationId);
  console.log(`  ${contacts.length} contacts`);

  console.log('[shrewsbury-export] fetching opportunities…');
  const opps = await fetchAllOpportunities(pit, locationId);
  console.log(`  ${opps.length} opportunities`);

  // Map: contactId → [opportunities]. We dump opportunity stages /
  // values / pipeline names as flattened columns (first/best opp).
  const oppsByContact = new Map();
  for (const o of opps) {
    const cid = o.contactId || o.contact?.id;
    if (!cid) continue;
    const list = oppsByContact.get(cid) ?? [];
    list.push(o);
    oppsByContact.set(cid, list);
  }

  // First pass: build a slim row per contact so we can compute
  // duplicate buckets before final assembly.
  const rows = [];
  for (const ct of contacts) {
    const row = {
      contact_id: ct.id,
      contact_first_name: ct.firstName ?? '',
      contact_last_name:  ct.lastName  ?? '',
      contact_email:      ct.email     ?? '',
      contact_phone:      ct.phone     ?? '',
      contact_created_at: ct.dateAdded ?? '',
      contact_tags:       (ct.tags || []).join('; '),
    };
    for (const [outCol, candidates] of Object.entries(FIELDS_TO_PULL)) {
      row[outCol] = valueOf(ct, fieldIdsByKey, candidates);
    }

    // Best-opportunity columns. Sort by monetary value desc, then
    // most recent update — usually the most relevant for the CFO.
    const oppList = (oppsByContact.get(ct.id) ?? []).slice().sort((a, b) => {
      const av = Number(a.monetaryValue || a.value || 0);
      const bv = Number(b.monetaryValue || b.value || 0);
      if (av !== bv) return bv - av;
      return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    });
    const bestOpp = oppList[0];
    row.opp_pipeline      = bestOpp?.pipelineId ? (bestOpp.pipelineName || bestOpp.pipelineId) : '';
    row.opp_stage         = bestOpp?.pipelineStageName || bestOpp?.stageName || '';
    row.opp_status        = bestOpp?.status || '';
    row.opp_value         = bestOpp?.monetaryValue ?? bestOpp?.value ?? '';
    row.opp_assigned_to   = bestOpp?.assignedTo || '';
    row.opp_created       = bestOpp?.createdAt || '';
    row.opp_updated       = bestOpp?.updatedAt || '';
    row.opps_total_count  = oppList.length;
    row.opps_other_stages = oppList.slice(1).map((o) =>
      `${o.pipelineStageName || o.stageName || '?'} (${o.status || '?'})`).join('; ');

    rows.push(row);
  }

  // Duplicate detection across the full set.
  // Buckets:
  //   email   — same normalized email
  //   phone   — same last-10 digits of any phone
  //   name1   — same lowercased parent1 first+last
  const byEmail = new Map();
  const byPhone = new Map();
  const byName1 = new Map();
  for (const r of rows) {
    const emails = [r.contact_email, r.parent1_email, r.parent2_email].map(normEmail).filter(Boolean);
    const phones = [r.contact_phone, r.parent1_phone, r.parent2_phone].map(normPhone).filter(Boolean);
    const name1  = normName(r.parent1_first_name || r.contact_first_name, r.parent1_last_name || r.contact_last_name);
    for (const e of emails) {
      if (!byEmail.has(e)) byEmail.set(e, new Set());
      byEmail.get(e).add(r.contact_id);
    }
    for (const p of phones) {
      if (!byPhone.has(p)) byPhone.set(p, new Set());
      byPhone.get(p).add(r.contact_id);
    }
    if (name1) {
      if (!byName1.has(name1)) byName1.set(name1, new Set());
      byName1.get(name1).add(r.contact_id);
    }
  }
  function collisions(map, key, self) {
    const set = map.get(key);
    if (!set) return [];
    return [...set].filter((id) => id !== self);
  }
  for (const r of rows) {
    const flags = new Set();
    const collidesWith = new Set();
    const emails = [r.contact_email, r.parent1_email, r.parent2_email].map(normEmail).filter(Boolean);
    const phones = [r.contact_phone, r.parent1_phone, r.parent2_phone].map(normPhone).filter(Boolean);
    const name1  = normName(r.parent1_first_name || r.contact_first_name, r.parent1_last_name || r.contact_last_name);
    for (const e of emails) {
      const others = collisions(byEmail, e, r.contact_id);
      if (others.length > 0) { flags.add('email'); others.forEach((o) => collidesWith.add(o)); }
    }
    for (const p of phones) {
      const others = collisions(byPhone, p, r.contact_id);
      if (others.length > 0) { flags.add('phone'); others.forEach((o) => collidesWith.add(o)); }
    }
    if (name1) {
      const others = collisions(byName1, name1, r.contact_id);
      if (others.length > 0) { flags.add('parent1_name'); others.forEach((o) => collidesWith.add(o)); }
    }
    r.duplicate_flag    = flags.size > 0 ? 'DUP' : '';
    r.duplicate_reasons = [...flags].sort().join(', ');
    r.dup_with_contacts = [...collidesWith].sort().join('; ');
  }

  // Write CSV
  const columns = [
    'contact_id',
    'contact_first_name', 'contact_last_name', 'contact_email', 'contact_phone',
    'contact_created_at',
    'contact_tags',
    // Parents
    'parent1_first_name', 'parent1_last_name', 'parent1_email', 'parent1_phone',
    'parent1_gender', 'parent1_relationship',
    'parent2_first_name', 'parent2_last_name', 'parent2_email', 'parent2_phone',
    'parent2_relationship',
    // Student 1
    'student1_first_name', 'student1_last_name', 'student1_dob', 'student1_gender',
    'student1_grade', 'student1_year_of_entry', 'student1_program', 'student1_financial_aid',
    // Student 2
    'student2_first_name', 'student2_last_name', 'student2_grade', 'student2_financial_aid',
    // Student 3
    'student3_first_name', 'student3_last_name', 'student3_grade', 'student3_year_of_entry',
    'student3_financial_aid',
    // Admissions
    'enrollment_status', 'admissions_status', 'applying_for', 'campus_applying_for',
    'current_school', 'app_submitted_date', 'app_accepted_date', 'app_declined_date',
    'enrollment_start_date', 'admissions_total_fees',
    // Opportunity (best one per contact)
    'opp_pipeline', 'opp_stage', 'opp_status', 'opp_value', 'opp_assigned_to',
    'opp_created', 'opp_updated', 'opps_total_count', 'opps_other_stages',
    // Duplicates
    'duplicate_flag', 'duplicate_reasons', 'dup_with_contacts',
  ];

  const header = columns.join(',') + '\n';
  const body = rows.map((r) => columns.map((c) => csvEscape(r[c] ?? '')).join(',')).join('\n');

  const outDir = join(projectRoot, 'out');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `shrewsbury-admissions-${ymd()}.csv`);
  writeFileSync(outPath, header + body, 'utf8');

  const dupCount = rows.filter((r) => r.duplicate_flag === 'DUP').length;
  console.log(`\n✓ Wrote ${rows.length} rows to ${outPath}`);
  console.log(`  ${dupCount} rows flagged as potential duplicates`);
  console.log(`  ${rows.filter((r) => r.opps_total_count > 0).length} contacts have at least 1 opportunity`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => pool.end());
