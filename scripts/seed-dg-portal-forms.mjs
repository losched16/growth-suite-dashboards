// Seed 17 portal-form definitions for Desert Garden Montessori (DG).
//
// Two forms are fully detailed (from confirmed Google Forms):
//   - Cafe Worker Permission Form (Student-specific)
//   - Authorization for Release / Pickup Authorization (per-family)
//
// The remaining 15 are placeholders with `needs_review = true` — operator
// (Clint) will replace the field_schema after gathering each form's
// content from DG. Each placeholder has a plausible category +
// per_student flag inferred from the form's name so the FormCompletionGrid
// in the dashboard immediately shows reasonable columns.
//
// Idempotent: ON CONFLICT (school_id, slug) DO UPDATE only refreshes
// the columns we own. Existing field_schemas are preserved when they
// have been edited (we check `needs_review` flag).
//
// Usage:
//   DATABASE_URL=... node scripts/seed-dg-portal-forms.mjs --school-id <uuid>
//   add --refresh to force-overwrite existing definitions (for re-seed).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// .env loader
const envText = readFileSync(join(projectRoot, '.env.local'), 'utf8');
for (const line of envText.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq).trim();
  const value = trimmed.slice(eq + 1).trim();
  if (!process.env[key]) process.env[key] = value;
}

const args = parseArgs(process.argv.slice(2));
if (!args.schoolId) {
  console.error('Usage: node scripts/seed-dg-portal-forms.mjs --school-id <uuid> [--refresh]');
  process.exit(2);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ─────────────────────────────────────────────────────────────────────
// CONFIRMED FORMS (full schema)
// ─────────────────────────────────────────────────────────────────────

const CAFE_WORKER = {
  slug: 'cafe-worker-permission',
  display_name: 'Cafe Worker Permission Form',
  description:
    'Permission for your child to work in the school cafe during their lunch period. '
    + 'Students who serve learn responsibility, hospitality, and food-handling basics.',
  category: 'permission',
  per_student: true,
  required_for: 'all',
  is_active: true,
  needs_review: false,
  field_schema: [
    { type: 'header', text: 'Cafe Worker Permission' },
    {
      type: 'paragraph',
      text:
        'My child has expressed interest in being a Cafe Worker. I understand that:\n'
        + '• They will help prepare and serve lunch to other students.\n'
        + '• They will be supervised by Cafe staff at all times.\n'
        + '• Cafe shifts will not interrupt instructional time.',
      emphasis: 'note',
    },
    {
      type: 'text',
      key: 'student_full_name',
      label: 'Student name',
      required: true,
      prefill: 'student.full_name',
    },
    {
      type: 'date',
      key: 'student_date_of_birth',
      label: 'Student date of birth',
      required: false,
      prefill: 'student.date_of_birth',
    },
    {
      type: 'checkbox',
      key: 'permission_granted',
      label: 'I give my child permission to work in the Cafe.',
      required: true,
    },
    {
      type: 'signature_typed',
      key: 'parent_signature',
      label: 'Parent / guardian signature',
      required: true,
      prefill: 'parent.full_name',
      acknowledgment:
        'By typing my full legal name below, I acknowledge I am the parent / '
        + 'legal guardian of the named student and grant the permissions above.',
    },
    {
      type: 'date',
      key: 'signature_date',
      label: 'Date signed',
      required: true,
      prefill: 'today',
    },
  ],
  ghl_writeback: [
    { field_key: 'permission_granted', ghl_field_key: 'cafe_worker_permission', per_student: true },
    { field_key: 'signature_date', ghl_field_key: 'cafe_worker_permission_date', per_student: true },
  ],
};

const RELEASE_AUTHORIZATION = {
  slug: 'authorization-for-release',
  display_name: 'Authorization for Release / Pickup Authorization',
  description:
    'List every person you authorize to pick up your child from school. We will '
    + 'verify ID on first pickup. Update this list any time someone changes.',
  category: 'release',
  per_student: false,
  required_for: 'all',
  is_active: true,
  needs_review: false,
  field_schema: [
    { type: 'header', text: 'Authorized Pickup List' },
    {
      type: 'paragraph',
      text:
        'List up to six (6) adults you authorize to pick your child up from school. '
        + 'Your family\'s primary parents are always authorized — do NOT list them here.',
      emphasis: 'note',
    },
    { type: 'section', label: 'Person 1', description: 'At least one authorized pickup is required.' },
    { type: 'text', key: 'pickup_1_name', label: 'Full name', required: true, width: 'half' },
    { type: 'text', key: 'pickup_1_relationship', label: 'Relationship to student', required: true, width: 'half' },
    { type: 'tel', key: 'pickup_1_phone', label: 'Phone', required: true, width: 'half' },

    { type: 'section', label: 'Person 2 (optional)' },
    { type: 'text', key: 'pickup_2_name', label: 'Full name', width: 'half' },
    { type: 'text', key: 'pickup_2_relationship', label: 'Relationship', width: 'half' },
    { type: 'tel', key: 'pickup_2_phone', label: 'Phone', width: 'half' },

    { type: 'section', label: 'Person 3 (optional)' },
    { type: 'text', key: 'pickup_3_name', label: 'Full name', width: 'half' },
    { type: 'text', key: 'pickup_3_relationship', label: 'Relationship', width: 'half' },
    { type: 'tel', key: 'pickup_3_phone', label: 'Phone', width: 'half' },

    { type: 'section', label: 'Person 4 (optional)' },
    { type: 'text', key: 'pickup_4_name', label: 'Full name', width: 'half' },
    { type: 'text', key: 'pickup_4_relationship', label: 'Relationship', width: 'half' },
    { type: 'tel', key: 'pickup_4_phone', label: 'Phone', width: 'half' },

    { type: 'section', label: 'Person 5 (optional)' },
    { type: 'text', key: 'pickup_5_name', label: 'Full name', width: 'half' },
    { type: 'text', key: 'pickup_5_relationship', label: 'Relationship', width: 'half' },
    { type: 'tel', key: 'pickup_5_phone', label: 'Phone', width: 'half' },

    { type: 'section', label: 'Person 6 (optional)' },
    { type: 'text', key: 'pickup_6_name', label: 'Full name', width: 'half' },
    { type: 'text', key: 'pickup_6_relationship', label: 'Relationship', width: 'half' },
    { type: 'tel', key: 'pickup_6_phone', label: 'Phone', width: 'half' },

    { type: 'section', label: 'Acknowledgement' },
    {
      type: 'paragraph',
      text:
        'I understand that the school will require a government-issued photo ID on '
        + 'first pickup for any name on this list, and that this list supersedes any '
        + 'previous authorization I have submitted.',
      emphasis: 'note',
    },
    {
      type: 'signature_typed',
      key: 'parent_signature',
      label: 'Parent / guardian signature',
      required: true,
      prefill: 'parent.full_name',
      acknowledgment: 'Type your full legal name to authorize the pickup list above.',
    },
    {
      type: 'date',
      key: 'signature_date',
      label: 'Date signed',
      required: true,
      prefill: 'today',
    },
  ],
  ghl_writeback: [
    { field_key: 'pickup_1_name', ghl_field_key: 'authorized_pickup_1_name' },
    { field_key: 'pickup_1_phone', ghl_field_key: 'authorized_pickup_1_phone' },
    { field_key: 'pickup_1_relationship', ghl_field_key: 'authorized_pickup_1_relationship' },
    { field_key: 'pickup_2_name', ghl_field_key: 'authorized_pickup_2_name' },
    { field_key: 'pickup_2_phone', ghl_field_key: 'authorized_pickup_2_phone' },
    { field_key: 'pickup_3_name', ghl_field_key: 'authorized_pickup_3_name' },
    { field_key: 'pickup_3_phone', ghl_field_key: 'authorized_pickup_3_phone' },
    { field_key: 'pickup_4_name', ghl_field_key: 'authorized_pickup_4_name' },
    { field_key: 'pickup_4_phone', ghl_field_key: 'authorized_pickup_4_phone' },
    { field_key: 'pickup_5_name', ghl_field_key: 'authorized_pickup_5_name' },
    { field_key: 'pickup_5_phone', ghl_field_key: 'authorized_pickup_5_phone' },
    { field_key: 'pickup_6_name', ghl_field_key: 'authorized_pickup_6_name' },
    { field_key: 'pickup_6_phone', ghl_field_key: 'authorized_pickup_6_phone' },
  ],
};

// ─────────────────────────────────────────────────────────────────────
// PLACEHOLDER FORMS (needs_review = true)
// ─────────────────────────────────────────────────────────────────────
// These have a single-field placeholder schema (just signature) so the
// renderer doesn't crash. Operator will replace with the real schema
// after gathering each form's content from DG.

function placeholder({
  slug, display_name, description, category, per_student, required_for = 'all',
}) {
  return {
    slug, display_name, description, category, per_student, required_for,
    is_active: false,                              // hidden from parents until reviewed
    needs_review: true,
    field_schema: [
      {
        type: 'paragraph',
        emphasis: 'warning',
        text:
          'This form is currently in draft. The school is finalising the questions. '
          + 'Please check back soon, or contact the school office.',
      },
      {
        type: 'signature_typed',
        key: 'parent_signature',
        label: 'Parent / guardian signature',
        required: true,
        prefill: 'parent.full_name',
        acknowledgment: 'Type your full legal name.',
      },
      { type: 'date', key: 'signature_date', label: 'Date signed', required: true, prefill: 'today' },
    ],
    ghl_writeback: [],
  };
}

const PLACEHOLDERS = [
  placeholder({
    slug: 'photography-media-release',
    display_name: 'Photography / Media Release',
    description: 'Permission for your child to appear in school photos and marketing materials.',
    category: 'release',
    per_student: true,
  }),
  placeholder({
    slug: 'field-trip-generic',
    display_name: 'Field Trip Permission (Generic)',
    description: 'Generic field-trip permission form. Specific trip details will be attached when used.',
    category: 'trip',
    per_student: true,
  }),
  placeholder({
    slug: 'field-trip-high-adventure',
    display_name: 'Field Trip Permission — High Adventure',
    description: 'For overnight, water, or high-risk trips with additional liability acknowledgements.',
    category: 'trip',
    per_student: true,
  }),
  placeholder({
    slug: 'health-form',
    display_name: 'Health Form / Medical Information',
    description: 'Annual health intake form including allergies, conditions, medications, and emergency contacts.',
    category: 'medical',
    per_student: true,
  }),
  placeholder({
    slug: 'allergy-special-diet',
    display_name: 'Allergy / Special Diet Form',
    description: 'Document any food allergies or dietary restrictions and how the school should accommodate.',
    category: 'medical',
    per_student: true,
  }),
  placeholder({
    slug: 'sunscreen-authorization',
    display_name: 'Sunscreen Application Authorization',
    description: 'Permission for school staff to apply sunscreen to your child.',
    category: 'medical',
    per_student: true,
  }),
  placeholder({
    slug: 'otc-medication-authorization',
    display_name: 'OTC Medication Authorization',
    description: 'Permission for school staff to administer over-the-counter medication (e.g. Tylenol).',
    category: 'medical',
    per_student: true,
  }),
  placeholder({
    slug: 'concussion-acknowledgement',
    display_name: 'Concussion Acknowledgement',
    description: 'Required for sports participation. Acknowledges concussion signs/symptoms protocol.',
    category: 'medical',
    per_student: true,
  }),
  placeholder({
    slug: 'sports-participation',
    display_name: 'Sports Participation Form',
    description: 'Permission and acknowledgement for participating in school sports.',
    category: 'permission',
    per_student: true,
  }),
  placeholder({
    slug: 'volunteer-background-check',
    display_name: 'Volunteer Background Check',
    description: 'Required before volunteering on campus or chaperoning a trip.',
    category: 'legal',
    per_student: false,
  }),
  placeholder({
    slug: 'carpool-authorization',
    display_name: 'Carpool Authorization',
    description: 'List families authorized to transport your child via carpool.',
    category: 'release',
    per_student: false,
  }),
  placeholder({
    slug: 'immunization-exemption',
    display_name: 'Immunization Exemption Statement',
    description: 'For families exempting from one or more required immunizations.',
    category: 'medical',
    per_student: true,
  }),
  placeholder({
    slug: 'internet-technology-use',
    display_name: 'Internet / Technology Use Agreement',
    description: 'Acceptable-use policy acknowledgement for student tech devices.',
    category: 'permission',
    per_student: true,
  }),
  placeholder({
    slug: 'tuition-agreement',
    display_name: 'Tuition Agreement',
    description: 'Annual tuition and payment-plan agreement.',
    category: 'legal',
    per_student: false,
  }),
  placeholder({
    slug: 'handbook-acknowledgement',
    display_name: 'Parent / Student Handbook Acknowledgement',
    description: 'Confirms your family has read and agreed to the parent / student handbook.',
    category: 'legal',
    per_student: false,
  }),
];

const ALL_FORMS = [CAFE_WORKER, RELEASE_AUTHORIZATION, ...PLACEHOLDERS];

// ─────────────────────────────────────────────────────────────────────

async function main() {
  // verify school exists
  const sRows = await pool.query(
    `SELECT id, name FROM schools WHERE id = $1`,
    [args.schoolId],
  );
  if (sRows.rowCount === 0) {
    console.error(`school ${args.schoolId} not found`);
    process.exit(2);
  }
  console.log(`Seeding portal-forms for "${sRows.rows[0].name}" (${args.schoolId})`);

  let created = 0, updated = 0, skipped = 0;
  for (const f of ALL_FORMS) {
    // If the form already exists with needs_review=false (operator has
    // edited it), DO NOT overwrite the schema — only refresh metadata.
    const existing = await pool.query(
      `SELECT id, needs_review FROM portal_form_definitions
       WHERE school_id = $1 AND slug = $2`,
      [args.schoolId, f.slug],
    );

    if (existing.rowCount === 0) {
      await pool.query(
        `INSERT INTO portal_form_definitions
           (school_id, slug, display_name, description, category, per_student,
            required_for, is_active, field_schema, ghl_writeback, needs_review)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11)`,
        [
          args.schoolId, f.slug, f.display_name, f.description, f.category, f.per_student,
          f.required_for, f.is_active, JSON.stringify(f.field_schema),
          JSON.stringify(f.ghl_writeback), f.needs_review,
        ],
      );
      console.log(`  ✓ created ${f.slug}`);
      created++;
      continue;
    }

    if (existing.rows[0].needs_review === false && !args.refresh) {
      console.log(`  ⊝ skipped ${f.slug} (already curated; pass --refresh to override)`);
      skipped++;
      continue;
    }

    await pool.query(
      `UPDATE portal_form_definitions
         SET display_name = $3,
             description = $4,
             category = $5,
             per_student = $6,
             required_for = $7,
             is_active = $8,
             field_schema = $9::jsonb,
             ghl_writeback = $10::jsonb,
             needs_review = $11
       WHERE school_id = $1 AND slug = $2`,
      [
        args.schoolId, f.slug, f.display_name, f.description, f.category, f.per_student,
        f.required_for, f.is_active, JSON.stringify(f.field_schema),
        JSON.stringify(f.ghl_writeback), f.needs_review,
      ],
    );
    console.log(`  ↻ updated ${f.slug}`);
    updated++;
  }

  console.log('');
  console.log(`Done. ${created} created, ${updated} updated, ${skipped} skipped.`);
  console.log(`Total form definitions in DB for this school: ${(await pool.query(
    `SELECT COUNT(*) FROM portal_form_definitions WHERE school_id = $1`,
    [args.schoolId],
  )).rows[0].count}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
}).finally(() => pool.end());

function parseArgs(argv) {
  const out = { schoolId: null, refresh: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--school-id') out.schoolId = argv[++i];
    else if (a === '--refresh') out.refresh = true;
  }
  return out;
}
