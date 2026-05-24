// One-off patch — bump emergency-medical and media-permission form schemas
// in the live DB so EC #2/#3 read as clearly optional sections and the
// Parent Roster Authorization heading has its own description blurb.
// Triggered after Rachel Kilgore reported she only saw one EC field and
// couldn't find the roster authorization on Wooster's testing pass.
//
// Idempotent: rewrites the entire field_schema jsonb for both forms.

import pg from 'pg';
import { readFileSync } from 'node:fs';

const env = readFileSync('.env.local', 'utf8');
const dbUrl = env.match(/^DATABASE_URL=(.*)$/m)?.[1]?.trim();
if (!dbUrl) throw new Error('no DATABASE_URL');

const c = new pg.Client({ connectionString: dbUrl });
await c.connect();

const sch = await c.query(`SELECT id FROM schools WHERE name ILIKE '%wooster%' LIMIT 1`);
const woosterId = sch.rows[0].id;

// Pull the current schemas, patch the section blocks, write back.
const r = await c.query(
  `SELECT id, slug, field_schema FROM portal_form_definitions
   WHERE school_id = $1 AND slug IN ('emergency-medical','media-permission')`,
  [woosterId],
);

for (const f of r.rows) {
  const schema = f.field_schema.map((b) => {
    if (b.type !== 'section') return b;
    if (b.label === 'Emergency Contact #2') {
      return { ...b, label: 'Emergency Contact #2 (optional)', description: "A backup if we can't reach Contact #1." };
    }
    if (b.label === 'Emergency Contact #3') {
      return { ...b, label: 'Emergency Contact #3 (optional)', description: 'A third option — useful if a grandparent or family friend may pick up.' };
    }
    if (b.label === 'Parent Roster Authorization') {
      return { ...b, description: "Required by Ohio preschool licensing — please tell us what you're comfortable sharing on the class roster." };
    }
    return b;
  }).map((b) => {
    // Tweak the roster_authorize label too — clearer, action-oriented.
    if (b.type === 'multi_checkbox' && b.key === 'roster_authorize') {
      return { ...b, label: "Check anything you'd like included on the parent roster (or leave all unchecked to opt out)" };
    }
    return b;
  });
  await c.query(
    `UPDATE portal_form_definitions SET field_schema = $1 WHERE id = $2`,
    [JSON.stringify(schema), f.id],
  );
  console.log('patched', f.slug);
}

await c.end();
console.log('done');
