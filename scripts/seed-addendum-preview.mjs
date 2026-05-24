// Seeds a completed form submission for the demo family so the
// addendum entry-point shows up on /forms-v2/[slug]. Also turns on
// allow_addendum for the tuition-enrollment + class-trip preview forms.
//
// Usage:
//   SCHOOL_ID=<uuid> FAMILY_ID=<uuid> node scripts/seed-addendum-preview.mjs

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
  if (!process.env[t.slice(0, eq).trim()]) process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
}

const SCHOOL_ID = process.env.SCHOOL_ID || '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
const FAMILY_ID = process.env.FAMILY_ID;

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  const c = await pool.connect();
  try {
    // 1) Make the preview forms addendum-friendly.
    await c.query(
      `UPDATE portal_form_definitions
          SET allow_addendum = true, updated_at = now()
        WHERE school_id = $1
          AND slug IN ('tuition-enrollment-2026-27', 'payments-preview-class-trip')`,
      [SCHOOL_ID],
    );

    // 2) Resolve demo family + an active student
    let familyId = FAMILY_ID;
    if (!familyId) {
      const { rows } = await c.query(
        `SELECT f.id FROM families f
           JOIN students s ON s.family_id = f.id AND s.status = 'active'
          WHERE f.school_id = $1
          GROUP BY f.id ORDER BY COUNT(s.id) DESC LIMIT 1`,
        [SCHOOL_ID],
      );
      if (rows.length === 0) throw new Error('No families with active students');
      familyId = rows[0].id;
    }
    const { rows: parentRows } = await c.query(
      `SELECT id FROM parents
        WHERE family_id = $1 AND school_id = $2 AND status = 'active'
        ORDER BY is_primary DESC, created_at ASC LIMIT 1`,
      [familyId, SCHOOL_ID],
    );
    const parentId = parentRows[0].id;
    const { rows: studentRows } = await c.query(
      `SELECT id FROM students
        WHERE family_id = $1 AND school_id = $2 AND status = 'active'
        ORDER BY first_name ASC LIMIT 1`,
      [familyId, SCHOOL_ID],
    );
    const studentId = studentRows[0].id;

    // 3) Find the tuition-enrollment form definition.
    const { rows: defRows } = await c.query(
      `SELECT id, slug FROM portal_form_definitions
        WHERE school_id = $1 AND slug = 'tuition-enrollment-2026-27' LIMIT 1`,
      [SCHOOL_ID],
    );
    if (defRows.length === 0) {
      console.log('No tuition-enrollment-2026-27 form found — run seed-payments-preview.mjs first.');
      return;
    }
    const defId = defRows[0].id;

    // 4) Wipe any prior demo-seeded submissions for this form/family,
    //    then insert a fresh parent submission so the addendum CTA
    //    surfaces in the UI.
    await c.query(
      `DELETE FROM portal_form_submissions
        WHERE family_id = $1 AND form_definition_id = $2
          AND user_agent = 'addendum-preview-seed'`,
      [familyId, defId],
    );
    const responses = {
      tuition_selection: JSON.stringify({
        tuition_grid_id: null,
        display_name: 'Primary Program (Ages 3–6, full day)',
        annual_tuition_cents: 1450000,
        plan_slug: '10-pay',
        plan_label: '10-pay (August–May)',
        plan_discount_bp: 0,
        addons: [
          { key: 'after_care', label: 'After Care (3pm–6pm)', amount_cents: 130000 },
          { key: 'enrollment_deposit', label: 'Re-enrollment deposit (non-refundable)', amount_cents: 25000 },
        ],
        total_cents: 1605000,
      }),
      parent_signature: 'Michelle Johnson',
      signature_date: '2026-04-12',
    };
    await c.query(
      `INSERT INTO portal_form_submissions
         (school_id, form_definition_id, family_id, parent_id, student_id,
          academic_year, responses, status, ip_address, user_agent,
          submitted_at)
       VALUES ($1, $2, $3, $4, $5, '2025-26', $6::jsonb, 'submitted',
               '127.0.0.1', 'addendum-preview-seed',
               now() - interval '37 days')`,
      [SCHOOL_ID, defId, familyId, parentId, studentId, JSON.stringify(responses)],
    );
    console.log('✓ Seeded a prior tuition-enrollment submission (37 days old).');
    console.log('  → Visit /forms-v2/tuition-enrollment-2026-27 — the violet "Update specific fields" banner appears at the top.');
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
