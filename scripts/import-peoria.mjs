// Peoria Montessori onboarding import.
//
// Reads three Mailchimp-export CSVs (Current parents / Alumni /
// General mailing list), dedups by email, and:
//   1. Upserts each unique contact into Peoria's GHL location with
//      the union of tags from every list that contained it + any
//      inline TAGS column values (Staff, Parent, Christmas party).
//   2. For non-staff rows that appeared in Current parents, clusters
//      them into families by shared last name and writes:
//        - families row  (status='active', display_name='X Family')
//        - parents row   (one per email, linked to family)
//      The classroom hint (Red Room / Blue Room / Elementary) goes
//      into family.notes so it's visible in the Family Hub widget.
//
// No students are created — the source files don't carry student
// data and the user explicitly asked to skip student DB writes.
//
// Idempotent: re-running merges tags onto existing GHL contacts and
// uses ON CONFLICT on families+parents to update in place.
//
// USAGE:
//   node scripts/import-peoria.mjs               (live run)
//   node scripts/import-peoria.mjs --dry-run     (parse + count only)
//   node scripts/import-peoria.mjs --skip-ghl    (DB writes only)
//   node scripts/import-peoria.mjs --skip-db     (GHL writes only)

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(join(here, '..', '.env.local'), 'utf8');
for (const ln of envText.split(/\r?\n/)) {
  const m = ln.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (!m) continue;
  let v = m[2]; if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  process.env[m[1]] = v;
}

const DRY      = process.argv.includes('--dry-run');
const SKIP_GHL = process.argv.includes('--skip-ghl');
const SKIP_DB  = process.argv.includes('--skip-db');

const PIT = 'pit-416d7c9b-1166-4355-82d7-266cddd06a7c';
const LOCATION_ID = 'cucEbOulc74TXTdHgL89';
const SCHOOL_ID = 'b0018576-be12-42ed-aaa7-6248e2756cf6';
const BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';

const DL = 'C:\\Users\\thelo\\Downloads';
const FILES = [
  { path: join(DL, 'Current_parents_email.csv'),     sourceTag: 'current-parent' },
  { path: join(DL, 'alumni_email.csv'),              sourceTag: 'alumni' },
  { path: join(DL, 'General_mailing_list_email.csv'), sourceTag: 'mailing-list-general' },
];

// ── CSV parser ────────────────────────────────────────────────────────
// Handles double-quoted fields with escaped quotes (RFC4180-ish).
function parseCsv(text) {
  const rows = [];
  let cur = []; let field = ''; let inQuote = false; let i = 0;
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

// ── Email + tag aggregation across all 3 files ────────────────────────
// Map<emailLower, { email, firstName, lastName, sources:Set<string>,
//                   inlineTags:Set<string>, classroom:string|null,
//                   memberSince:string|null, region:string }>
const byEmail = new Map();

for (const file of FILES) {
  const text = readFileSync(file.path, 'utf8');
  const rows = parseCsv(text);
  const header = rows[0].map((h) => h.toLowerCase().trim());
  const idx = (name) => header.findIndex((h) => h === name.toLowerCase());

  const emailIdx     = idx('email address');
  const firstIdx     = idx('first name');
  const lastIdx      = idx('last name');
  const tagsIdx      = idx('tags');
  const regionIdx    = idx('region');
  const memberIdx    = idx('member since');         // only on current-parents
  const classroomIdx = idx('classrooms');           // only on current-parents

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length < 2) continue;
    const emailRaw = row[emailIdx] ?? '';
    const email = emailRaw.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;

    let rec = byEmail.get(email);
    if (!rec) {
      rec = {
        email,
        firstName: (row[firstIdx] ?? '').trim(),
        lastName:  (row[lastIdx] ?? '').trim(),
        sources: new Set(),
        inlineTags: new Set(),
        classroom: null,
        memberSince: null,
        region: (regionIdx >= 0 ? (row[regionIdx] ?? '') : '').trim() || null,
      };
      byEmail.set(email, rec);
    } else {
      // Prefer the most-informative name (longer wins, current-parent wins ties)
      const newFirst = (row[firstIdx] ?? '').trim();
      const newLast  = (row[lastIdx] ?? '').trim();
      const newScore = newFirst.length + newLast.length;
      const curScore = rec.firstName.length + rec.lastName.length;
      if (newScore > curScore || (newScore === curScore && file.sourceTag === 'current-parent')) {
        rec.firstName = newFirst || rec.firstName;
        rec.lastName  = newLast  || rec.lastName;
      }
    }
    rec.sources.add(file.sourceTag);

    // Inline TAGS column — e.g. "Parent" / "Staff" / "Christmas party"
    if (tagsIdx >= 0) {
      const raw = (row[tagsIdx] ?? '').trim();
      if (raw) {
        // Mailchimp stuffs TAGS as quoted comma-separated: "Christmas party","Parent"
        for (const t of raw.split(',')) {
          const v = t.replace(/^"+|"+$/g, '').trim();
          if (v) rec.inlineTags.add(v.toLowerCase().replace(/\s+/g, '-'));
        }
      }
    }
    if (classroomIdx >= 0) {
      const cls = (row[classroomIdx] ?? '').trim();
      if (cls) rec.classroom = cls;
    }
    if (memberIdx >= 0) {
      const ms = (row[memberIdx] ?? '').trim();
      if (ms) rec.memberSince = ms;
    }
  }
}

console.log(`Unique emails across 3 files: ${byEmail.size}`);

// Override: any contact with @peoriamontessori.org email OR 'staff'
// inline tag is staff (not a parent). Move them out of current-parent.
let staffCount = 0;
for (const rec of byEmail.values()) {
  const isStaff = rec.email.endsWith('@peoriamontessori.org')
    || rec.inlineTags.has('staff');
  if (isStaff) {
    rec.isStaff = true;
    rec.sources.delete('current-parent');     // they're not parents
    rec.sources.add('staff');
    staffCount++;
  } else {
    rec.isStaff = false;
  }
}
console.log(`  staff (separated):                   ${staffCount}`);
const sourceCounts = {};
for (const rec of byEmail.values()) {
  for (const s of rec.sources) sourceCounts[s] = (sourceCounts[s] ?? 0) + 1;
}
console.log(`  source-tag distribution:`, sourceCounts);

const currentParents = [...byEmail.values()].filter((r) => r.sources.has('current-parent'));
console.log(`Current parents (non-staff):           ${currentParents.length}`);

// ── Family clustering by last name on current parents ─────────────────
const byLastName = new Map();
for (const p of currentParents) {
  const ln = (p.lastName || '').trim();
  if (!ln) continue;
  // Some last names have spaces (Toro Acosta, Meredith Cox) — keep as-is
  const key = ln.toLowerCase();
  if (!byLastName.has(key)) byLastName.set(key, []);
  byLastName.get(key).push(p);
}

console.log(`\nFamilies (clustered by last name): ${byLastName.size}`);
let multiParentCount = 0;
for (const [ln, members] of byLastName) {
  if (members.length > 1) {
    multiParentCount++;
    console.log(`  ${members.length}p · ${ln}: ${members.map((m) => `${m.firstName} (${m.email})`).join(', ')}`);
  }
}
console.log(`  multi-parent families: ${multiParentCount}`);
console.log(`  single-parent families: ${byLastName.size - multiParentCount}`);

// Parents with no last name → one family per email (orphans)
const noLastName = currentParents.filter((p) => !(p.lastName ?? '').trim());
console.log(`  parents without last name (will be solo families): ${noLastName.length}`);
for (const p of noLastName) console.log(`    · ${p.firstName || '(no name)'} <${p.email}>`);

if (DRY) {
  console.log('\n(dry run — exiting before any writes)');
  process.exit(0);
}

// ── GHL upsert ────────────────────────────────────────────────────────
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
  if (!r.ok) {
    return { ok: false, status: r.status, body };
  }
  return { ok: true, body };
}

let ghlCreated = 0, ghlUpdated = 0, ghlErrors = 0;

if (!SKIP_GHL) {
  console.log('\n── Phase 1: GHL upserts ──');
  let i = 0;
  for (const rec of byEmail.values()) {
    i++;
    const tags = [...rec.sources, ...rec.inlineTags];
    // /contacts/upsert — by locationId + email, merges tags via append
    const body = {
      locationId: LOCATION_ID,
      email: rec.email,
      firstName: rec.firstName || undefined,
      lastName:  rec.lastName  || undefined,
      tags,
      source: 'peoria-onboarding-import',
    };
    if (rec.region) body.state = rec.region.toUpperCase();
    const r = await ghl('/contacts/upsert', { method: 'POST', body: JSON.stringify(body) });
    if (!r.ok) {
      ghlErrors++;
      console.error(`  [${i}/${byEmail.size}] ERR ${rec.email}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
      continue;
    }
    const wasNew = r.body?.new === true || r.body?.contact?.new === true;
    if (wasNew) ghlCreated++; else ghlUpdated++;
    rec.ghlContactId = r.body?.contact?.id ?? r.body?.id ?? null;
    if (i % 50 === 0 || i === byEmail.size) {
      console.log(`  [${i}/${byEmail.size}] +${ghlCreated} new, ${ghlUpdated} updated, ${ghlErrors} err`);
    }
  }
  console.log(`\nGHL done: ${ghlCreated} new + ${ghlUpdated} updated + ${ghlErrors} errors  (total ${byEmail.size})`);
}

// ── DB writes: families + parents ─────────────────────────────────────
if (!SKIP_DB) {
  console.log('\n── Phase 2: DB families + parents ──');
  const { Client } = pg;
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  let famCreated = 0, parCreated = 0, parUpdated = 0;
  for (const [lnKey, members] of byLastName) {
    if (members.length === 0) continue;
    const lastName = members[0].lastName.trim();
    const displayName = `${lastName} Family`;
    // Aggregate classroom hints across members
    const classrooms = new Set();
    for (const m of members) if (m.classroom) for (const c0 of m.classroom.split(',').map((s) => s.trim())) if (c0) classrooms.add(c0);
    const memberSinces = [...new Set(members.map((m) => m.memberSince).filter(Boolean))];
    const notesParts = [];
    if (classrooms.size) notesParts.push(`Classrooms: ${[...classrooms].join(', ')}`);
    if (memberSinces.length) notesParts.push(`Member since: ${memberSinces.join('; ')}`);
    const notes = notesParts.join(' · ');

    // Upsert family by (school_id, display_name) — we don't have a
    // unique index on that pair, so emulate with a lookup-then-insert.
    const ex = await c.query(
      `SELECT id FROM families WHERE school_id = $1 AND display_name = $2 LIMIT 1`,
      [SCHOOL_ID, displayName],
    );
    let familyId;
    if (ex.rows.length) {
      familyId = ex.rows[0].id;
      await c.query(
        `UPDATE families SET notes = $2, status = 'active', updated_at = now() WHERE id = $1`,
        [familyId, notes || null],
      );
    } else {
      const ins = await c.query(
        `INSERT INTO families (school_id, display_name, notes, status) VALUES ($1, $2, $3, 'active') RETURNING id`,
        [SCHOOL_ID, displayName, notes || null],
      );
      familyId = ins.rows[0].id;
      famCreated++;
    }

    // Insert/update parents. Match by (school_id, email) to avoid dups.
    for (let mi = 0; mi < members.length; mi++) {
      const m = members[mi];
      const isPrimary = mi === 0;
      const ex2 = await c.query(
        `SELECT id, family_id FROM parents WHERE school_id = $1 AND lower(email) = $2 LIMIT 1`,
        [SCHOOL_ID, m.email],
      );
      if (ex2.rows.length) {
        await c.query(
          `UPDATE parents
              SET family_id = $2,
                  first_name = COALESCE(NULLIF($3, ''), first_name),
                  last_name  = COALESCE(NULLIF($4, ''), last_name),
                  ghl_contact_id = COALESCE($5, ghl_contact_id),
                  status = 'active',
                  updated_at = now()
            WHERE id = $1`,
          [ex2.rows[0].id, familyId, m.firstName || '', m.lastName || '', m.ghlContactId ?? null],
        );
        parUpdated++;
      } else {
        await c.query(
          `INSERT INTO parents
             (family_id, school_id, ghl_contact_id, first_name, last_name, email,
              role, is_primary, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'parent', $7, 'active')`,
          [familyId, SCHOOL_ID, m.ghlContactId ?? null,
           m.firstName || '', m.lastName || '', m.email, isPrimary],
        );
        parCreated++;
      }
    }
  }

  // Orphans (current parents with no last name) → solo families
  for (const m of noLastName) {
    const displayName = (m.firstName || m.email.split('@')[0]).trim() + ' Family';
    const ex = await c.query(
      `SELECT id FROM families WHERE school_id = $1 AND display_name = $2 LIMIT 1`,
      [SCHOOL_ID, displayName],
    );
    let familyId;
    if (ex.rows.length) {
      familyId = ex.rows[0].id;
    } else {
      const ins = await c.query(
        `INSERT INTO families (school_id, display_name, notes, status) VALUES ($1, $2, $3, 'active') RETURNING id`,
        [SCHOOL_ID, displayName, m.classroom ? `Classroom: ${m.classroom}` : null],
      );
      familyId = ins.rows[0].id;
      famCreated++;
    }
    const ex2 = await c.query(
      `SELECT id FROM parents WHERE school_id = $1 AND lower(email) = $2 LIMIT 1`,
      [SCHOOL_ID, m.email],
    );
    if (ex2.rows.length) {
      await c.query(
        `UPDATE parents SET family_id = $2, ghl_contact_id = COALESCE($3, ghl_contact_id),
              status = 'active', updated_at = now() WHERE id = $1`,
        [ex2.rows[0].id, familyId, m.ghlContactId ?? null],
      );
      parUpdated++;
    } else {
      await c.query(
        `INSERT INTO parents (family_id, school_id, ghl_contact_id, first_name, last_name, email,
            role, is_primary, status)
          VALUES ($1, $2, $3, $4, $5, $6, 'parent', true, 'active')`,
        [familyId, SCHOOL_ID, m.ghlContactId ?? null, m.firstName || '', '', m.email],
      );
      parCreated++;
    }
  }

  console.log(`DB done: ${famCreated} families created, ${parCreated} parents created, ${parUpdated} parents updated`);
  const ts = await c.query(`SELECT count(*) FROM families WHERE school_id = $1`, [SCHOOL_ID]);
  const ps = await c.query(`SELECT count(*) FROM parents WHERE school_id = $1`, [SCHOOL_ID]);
  console.log(`Totals in DB: families=${ts.rows[0].count}, parents=${ps.rows[0].count}`);
  await c.end();
}

console.log('\nDone.');
