// Add an "Applies to which students?" picker after EACH emergency
// contact slot in Wooster's emergency-medical form. The new block
// type student_applicability renders a checkbox list scoped to the
// family's actual students (rendered client-side at form load).
//
// Idempotent: only inserts blocks that aren't already present.

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
const def = r.rows[0];
if (!def) throw new Error('emergency-medical not found');

const schema = def.field_schema;

// For each EC slot (1..5), insert a student_applicability block right
// after `ec<N>_phone` IF one isn't already there. We anchor on _phone
// because that's always the last field of each contact's group.
const slots = [1, 2, 3, 4, 5];
const newSchema = [];
for (const b of schema) {
  newSchema.push(b);
  if (b.key && /^ec\d_phone$/.test(b.key)) {
    const slot = Number(b.key.match(/^ec(\d)_phone$/)?.[1]);
    if (!slots.includes(slot)) continue;
    const appliesKey = `ec${slot}_applies_to`;
    // Skip if already present in the source schema
    if (schema.some((x) => x.key === appliesKey)) continue;
    newSchema.push({
      type: 'student_applicability',
      key: appliesKey,
      label: 'Applies to which students?',
      help: 'Choose every child this contact can be called for. Defaults to all students.',
      default_selection: 'all',
    });
  }
}

// Also tack one onto the overflow textarea so the school knows which
// kids the free-form list applies to.
if (!schema.some((x) => x.key === 'additional_emergency_contacts_applies_to')) {
  const overflowIdx = newSchema.findIndex((x) => x.key === 'additional_emergency_contacts');
  if (overflowIdx >= 0) {
    newSchema.splice(overflowIdx + 1, 0, {
      type: 'student_applicability',
      key: 'additional_emergency_contacts_applies_to',
      label: 'These additional contacts apply to:',
      default_selection: 'all',
    });
  }
}

if (JSON.stringify(newSchema) === JSON.stringify(schema)) {
  console.log('schema already has applies_to fields — nothing to do');
} else {
  await c.query(
    `UPDATE portal_form_definitions SET field_schema = $1, updated_at = now() WHERE id = $2`,
    [JSON.stringify(newSchema), def.id],
  );
  console.log(`patched: schema length ${schema.length} → ${newSchema.length}`);
}
await c.end();
