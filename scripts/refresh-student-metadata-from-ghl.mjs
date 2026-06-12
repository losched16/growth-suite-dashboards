// One-off runner for the GHL → students.metadata propagation
// (same logic as lib/sync/ghl-student-metadata.ts, runnable outside
// Next). Copies per-student slot fields from the already-synced
// ghl_contact_field_values into students.metadata so metadata-backed
// dashboard columns (tuition, program, lead teacher…) match the GHL
// contact record.
//
//   node scripts/refresh-student-metadata-from-ghl.mjs <schoolId>           # dry-run report
//   node scripts/refresh-student-metadata-from-ghl.mjs <schoolId> --apply
import { readFileSync } from 'node:fs';
import pg from 'pg';

const SCHOOL_ID = process.argv[2];
const APPLY = process.argv.includes('--apply');
if (!SCHOOL_ID || SCHOOL_ID.startsWith('--')) {
  console.error('Usage: node scripts/refresh-student-metadata-from-ghl.mjs <schoolId> [--apply]');
  process.exit(1);
}

for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('='); if (eq < 0) continue;
  const k = t.slice(0, eq).trim();
  if (!process.env[k]) process.env[k] = t.slice(eq + 1).trim().replace(/^"|"$/g, '');
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const SLOT_KEY_RE = /^student_(?:([2-4])_)?(.+)$/;
const SKIP_BASES = new Set(['first_name', 'last_name', 'preferred_name', 'birth_date', 'gender', 'id']);

const { rows: parents } = await pool.query(
  `SELECT family_id, ghl_contact_id FROM parents
    WHERE school_id = $1 AND status = 'active' AND ghl_contact_id IS NOT NULL
    ORDER BY is_primary DESC, created_at ASC`, [SCHOOL_ID]);
const contactsByFamily = new Map();
for (const p of parents) {
  const list = contactsByFamily.get(p.family_id) ?? [];
  list.push(p.ghl_contact_id);
  contactsByFamily.set(p.family_id, list);
}

const { rows: cfv } = await pool.query(
  `SELECT ghl_contact_id, field_key, value FROM ghl_contact_field_values
    WHERE school_id = $1 AND field_key LIKE 'student%'`, [SCHOOL_ID]);
const bySlot = new Map();
for (const r of cfv) {
  const m = SLOT_KEY_RE.exec(r.field_key);
  if (!m) continue;
  const slot = m[1] ? parseInt(m[1], 10) : 1;
  const base = m[2];
  if (!base || SKIP_BASES.has(base)) continue;
  const v = (r.value ?? '').trim();
  if (!v) continue;
  let slots = bySlot.get(r.ghl_contact_id);
  if (!slots) { slots = new Map(); bySlot.set(r.ghl_contact_id, slots); }
  let bases = slots.get(slot);
  if (!bases) { bases = new Map(); slots.set(slot, bases); }
  bases.set(base, v);
}

const { rows: students } = await pool.query(
  `SELECT id, first_name, last_name, family_id, metadata
     FROM students WHERE school_id = $1 AND status = 'active'`, [SCHOOL_ID]);

let withSlot = 0, updated = 0, keys = 0;
for (const s of students) {
  const md = s.metadata ?? {};
  const slot = parseInt(String(md.ghl_slot ?? ''), 10);
  if (!Number.isInteger(slot) || slot < 1 || slot > 4) continue;
  withSlot++;

  const merged = new Map();
  for (const contactId of contactsByFamily.get(s.family_id) ?? []) {
    const bases = bySlot.get(contactId)?.get(slot);
    if (!bases) continue;
    for (const [base, v] of bases) if (!merged.has(base)) merged.set(base, v);
  }
  if (merged.size === 0) continue;

  const patch = {};
  for (const [base, v] of merged) {
    if (String(md[base] ?? '') !== v) patch[base] = v;
  }
  const n = Object.keys(patch).length;
  if (n === 0) continue;

  updated++;
  keys += n;
  const shown = Object.entries(patch).slice(0, 6)
    .map(([k, v]) => `${k}: ${JSON.stringify(md[k] ?? null)} -> ${JSON.stringify(v)}`).join('; ');
  console.log(`${s.first_name} ${s.last_name} (slot ${slot}): ${n} keys — ${shown}${n > 6 ? ' …' : ''}`);

  if (APPLY) {
    await pool.query(
      `UPDATE students SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = now()
        WHERE id = $1`,
      [s.id, JSON.stringify(patch)],
    );
  }
}

console.log(`\n${APPLY ? 'APPLIED' : 'DRY-RUN'}: ${students.length} active students, ${withSlot} with ghl_slot, ${updated} would change (${keys} keys).`);
await pool.end();
