// Extend Wooster's emergency-medical form schema to support up to 5
// emergency contacts (was 3). Rachel reported on her test call that
// some families have more than 3 people to list.
//
// Idempotent: inserts ec4_ + ec5_ fields right after the existing ec3
// block, but only if they're not already present.

import pg from 'pg';
import { readFileSync } from 'node:fs';

const env = readFileSync('.env.local', 'utf8');
const dbUrl = env.match(/^DATABASE_URL=(.*)$/m)?.[1]?.trim();
const c = new pg.Client({ connectionString: dbUrl });
await c.connect();

const sch = await c.query(`SELECT id FROM schools WHERE name ILIKE '%wooster%' LIMIT 1`);
const woosterId = sch.rows[0].id;

const r = await c.query(
  `SELECT id, field_schema FROM portal_form_definitions
   WHERE school_id = $1 AND slug = 'emergency-medical'`,
  [woosterId],
);
if (r.rows.length === 0) throw new Error('emergency-medical not found');
const def = r.rows[0];

const schema = def.field_schema;
const hasEc4 = schema.some((b) => b.key === 'ec4_name');
const hasEc5 = schema.some((b) => b.key === 'ec5_name');
const hasOverflow = schema.some((b) => b.key === 'additional_emergency_contacts');
if (hasEc4 && hasEc5 && hasOverflow) {
  console.log('ec4 + ec5 + additional_emergency_contacts already present — nothing to do');
  await c.end();
  process.exit(0);
}

// Find the anchor to insert after. Prefer the last ec block already
// present so we always sit between the structured slots and the
// signature / consent section that follows them.
const anchorKey =
  schema.some((b) => b.key === 'ec5_phone') ? 'ec5_phone' :
  schema.some((b) => b.key === 'ec4_phone') ? 'ec4_phone' :
  schema.some((b) => b.key === 'ec3_phone') ? 'ec3_phone' :
  null;
if (!anchorKey) throw new Error('could not find any ec3_phone/ec4_phone/ec5_phone in schema to anchor insert');
const lastEc3Idx = schema.map((b, i) => b.key === anchorKey ? i : -1).filter((i) => i >= 0).pop();

const newBlocks = [];
if (!hasEc4) newBlocks.push(
  { type: 'section', label: 'Emergency Contact #4 (optional)', description: 'A fourth contact if Contacts #1–#3 are unavailable.' },
  { type: 'text', key: 'ec4_name',         label: 'Name', width: 'half' },
  { type: 'text', key: 'ec4_relationship', label: 'Relationship to student', width: 'half' },
  { type: 'tel',  key: 'ec4_phone',        label: 'Phone', width: 'half' },
);
if (!hasEc5) newBlocks.push(
  { type: 'section', label: 'Emergency Contact #5 (optional)', description: 'A fifth contact, in case more options are needed.' },
  { type: 'text', key: 'ec5_name',         label: 'Name', width: 'half' },
  { type: 'text', key: 'ec5_relationship', label: 'Relationship to student', width: 'half' },
  { type: 'tel',  key: 'ec5_phone',        label: 'Phone', width: 'half' },
);
if (!hasOverflow) newBlocks.push(

  // Overflow textarea — for any family with MORE than five emergency
  // contacts. Free-form is fine here: the goal is to capture name +
  // phone + relationship so the school can call them in an emergency.
  {
    type: 'section',
    label: 'Additional Emergency Contacts (optional)',
    description: "If you have more than five, list any extras here — one per line with name, relationship, and phone.",
  },
  {
    type: 'textarea',
    key: 'additional_emergency_contacts',
    label: 'Additional contacts',
    rows: 4,
    placeholder: 'e.g.\nJane Smith - Aunt - (555) 123-4567\nBob Jones - Family friend - (555) 765-4321',
    help: "One per line. School staff will see exactly what you type here, so include name + relationship + phone.",
  },
);

// Splice in right after the last ec3 block
const updated = [
  ...schema.slice(0, lastEc3Idx + 1),
  ...newBlocks,
  ...schema.slice(lastEc3Idx + 1),
];

await c.query(
  `UPDATE portal_form_definitions SET field_schema = $1, updated_at = now() WHERE id = $2`,
  [JSON.stringify(updated), def.id],
);
console.log(`patched: added ec4 and ec5 blocks. New schema length: ${updated.length}`);

await c.end();
