// One-off cleanup: remove or prefill redundant student-name fields
// across DGM's parent-portal forms.
//
// Rationale:
//   The parent portal already requires the parent to pick a student
//   before the form renders. Asking for "Student Name" as a text field
//   on the form is redundant and creates double-data-entry friction.
//
// Policy (matches the user's "smart mix" decision on 2026-05-26):
//   - 5 LEGAL forms keep the field, but it auto-prefills from the
//     selected student (parent can still edit if the legal name
//     differs). Audit/legal trail unchanged because the typed name
//     still lands in the responses JSON.
//   - All other forms with a student-name field have it REMOVED.
//     The submission row already has student_id, so the inbox can
//     show the name via a join.
//
// This script is safe to re-run — idempotent. Each pass:
//   - Loads each affected form's field_schema
//   - For each field, applies the policy below
//   - Writes back only if the schema actually changed
//
// Companion change: scripts/seed-dgm-forms-from-brief.mjs has been
// patched to apply the same transformation, so re-seeding from the
// inventory JSON won't re-introduce these fields.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

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

const SCHOOL_ID = process.env.DGM_SCHOOL_ID || 'cfa9030d-c8fe-49ae-a9e7-f1003844ec07';

// Forms whose typed student name IS the legal record — keep the field
// but auto-prefill. Parent can still override.
const LEGAL_FORMS = new Set([
  'az-state-emergency-immunization-card',
  'az-state-medication-consent',
  'myhs-otc-medication-consent',
  'request-administering-medication',
  'records-release-authorization',
]);

// Field keys we treat as "student name" fields. The mapping value is
// the prefill source key — used when the form is in LEGAL_FORMS.
const NAME_FIELD_PREFILL = {
  'child_name':         'student.full_name',
  'student_name':       'student.full_name',
  'student_full_name':  'student.full_name',
  'student_first_name': 'student.first_name',
  'student_last_name':  'student.last_name',
  'child_first_name':   'student.first_name',
  'child_last_name':    'student.last_name',
};

function transformBlock(block, slug) {
  if (!block || typeof block !== 'object') return block;
  const key = String(block.key ?? '').trim();
  if (!key || !(key in NAME_FIELD_PREFILL)) return block;
  if (LEGAL_FORMS.has(slug)) {
    // Add prefill if not already set — parent sees the name auto-
    // populated. Doesn't change `required` or anything else.
    if (block.prefill) return block;
    return { ...block, prefill: NAME_FIELD_PREFILL[key] };
  }
  // Otherwise — drop the block entirely.
  return null;
}

// Returns the cleaned-up field_schema, or `null` if nothing changed.
export function cleanupSchema(schema, slug) {
  if (!Array.isArray(schema)) return null;
  let changed = false;
  const out = [];
  for (const block of schema) {
    const next = transformBlock(block, slug);
    if (next === null) {
      changed = true;
      continue;
    }
    if (next !== block) changed = true;
    out.push(next);
  }
  return changed ? out : null;
}

async function main() {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  const { rows } = await pool.query(
    `SELECT id, slug, display_name, field_schema
       FROM portal_form_definitions
      WHERE school_id = $1 AND audience = 'parents'`,
    [SCHOOL_ID],
  );

  let touched = 0;
  for (const r of rows) {
    const next = cleanupSchema(r.field_schema, r.slug);
    if (!next) continue;
    const removed = (r.field_schema?.length ?? 0) - next.length;
    const action = LEGAL_FORMS.has(r.slug) ? 'prefilled' : (removed > 0 ? `removed ${removed} field${removed === 1 ? '' : 's'}` : 'no-op');
    await pool.query(
      `UPDATE portal_form_definitions
          SET field_schema = $1::jsonb, updated_at = now()
        WHERE id = $2`,
      [JSON.stringify(next), r.id],
    );
    console.log(`  ✓ ${r.slug.padEnd(40)} — ${action}`);
    touched++;
  }
  console.log(`\nDone. ${touched} form${touched === 1 ? '' : 's'} updated.`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
