// Create the 3 GHL custom fields the split-billing writeback needs.
// Run for each tenant — script handles MCH and DGM in one shot; pass
// --school-id <uuid> to target a single school.
//
// Fields (all created on the Contact model so they live on each parent's
// contact, not the family/business level):
//
//   Name                          dataType    fieldKey (auto-generated)
//   ────────────────────────────────────────────────────────────────────
//   Billing Share Percentage      TEXT        billing_share_percentage
//   Billing Share Annual Amount   MONETARY    billing_share_annual_amount
//   Billing Plan                  TEXT        billing_plan
//
// The writeback (lib/billing/tuition-ghl-writeback.ts → writebackBillingShareToGhl)
// looks for these exact fieldKeys. GHL auto-derives the key from the
// display name when you don't pass one, so we just send the name +
// dataType and it picks the matching snake_case.
//
// Idempotent: lists existing fields first and skips matches by fieldKey
// (or normalized name). Safe to re-run.
//
// Usage:
//   npx tsx scripts/create-ghl-split-billing-fields.mjs                 # both MCH + DGM
//   npx tsx scripts/create-ghl-split-billing-fields.mjs --school-id <uuid>
//   npx tsx scripts/create-ghl-split-billing-fields.mjs --dry-run       # report only

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const args = parseArgs(process.argv.slice(2));

// Target schools: MCH + DGM by default. The --school-id flag overrides.
const DEFAULT_SCHOOLS = [
  { id: 'a6c4b2dd-050c-4bf9-893b-67106f0f20e8', label: "Media Children's House (MCH)" },
  { id: 'cfa9030d-c8fe-49ae-a9e7-f1003844ec07', label: 'Desert Garden Montessori (DGM)' },
];

const SCHOOLS = args.schoolId
  ? [{ id: args.schoolId, label: '(custom)' }]
  : DEFAULT_SCHOOLS;

// GHL's `MONETORY` is intentionally misspelled in their API (so is
// `customFields[].dataType: 'MONETORY'` in responses). They've never
// fixed it for backward-compat. Keep this spelling exact.
const REQUIRED_FIELDS = [
  { name: 'Billing Share Percentage',    dataType: 'TEXT',      fieldKey: 'billing_share_percentage' },
  { name: 'Billing Share Annual Amount', dataType: 'MONETORY',  fieldKey: 'billing_share_annual_amount' },
  { name: 'Billing Plan',                dataType: 'TEXT',      fieldKey: 'billing_plan' },
];

// Lazy-load the TS helper so this script runs through tsx.
const { loadGhlClient } = await import('../lib/ghl/client.ts');

const normalize = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');

async function listExistingFields(client) {
  const res = await client.axios.get(`/locations/${client.locationId}/customFields`);
  return res.data?.customFields ?? [];
}

async function createField(client, def, dryRun) {
  const body = {
    name: def.name,
    dataType: def.dataType,
    model: 'contact',
  };
  if (dryRun) {
    return { ok: true, dry: true, body };
  }
  try {
    const res = await client.axios.post(`/locations/${client.locationId}/customFields`, body);
    return { ok: true, field: res.data?.customField };
  } catch (e) {
    const detail = e.response?.data ? JSON.stringify(e.response.data) : (e.message ?? String(e));
    return { ok: false, error: detail };
  }
}

async function provisionForSchool(school) {
  console.log(`\n── ${school.label} (${school.id}) ──`);
  let client;
  try {
    client = await loadGhlClient(school.id);
  } catch (e) {
    console.error(`  ✗ Could not load GHL client: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false };
  }

  const existing = await listExistingFields(client);
  console.log(`  Found ${existing.length} existing custom fields on the location`);

  // Build a lookup by normalized name AND by fieldKey suffix
  // (GHL prefixes some keys with "contact." — strip before compare).
  const byMatch = new Map();
  for (const f of existing) {
    const name = (f.name ?? '').toString();
    const rawKey = (f.fieldKey ?? f.key ?? '').toString();
    const keySuffix = rawKey.includes('.') ? rawKey.split('.', 2)[1] : rawKey;
    if (name)      byMatch.set(`name:${normalize(name)}`, f);
    if (rawKey)    byMatch.set(`key:${normalize(rawKey)}`, f);
    if (keySuffix) byMatch.set(`key:${normalize(keySuffix)}`, f);
  }

  let created = 0, skipped = 0, failed = 0;
  for (const def of REQUIRED_FIELDS) {
    const match = byMatch.get(`key:${normalize(def.fieldKey)}`)
                ?? byMatch.get(`name:${normalize(def.name)}`);
    if (match) {
      console.log(`  ⊝ exists: ${def.name.padEnd(32)} → ${match.fieldKey ?? match.key ?? '(no key)'}`);
      skipped++;
      continue;
    }
    const r = await createField(client, def, args.dryRun);
    if (r.dry) {
      console.log(`  • DRY:    ${def.name.padEnd(32)} (${def.dataType})`);
      created++;
    } else if (r.ok) {
      const key = r.field?.fieldKey ?? r.field?.key ?? '(no key returned)';
      console.log(`  ✓ created: ${def.name.padEnd(32)} → ${key}`);
      created++;
    } else {
      console.log(`  ✗ failed:  ${def.name.padEnd(32)} ${r.error?.slice(0, 100) ?? ''}`);
      failed++;
    }
  }
  console.log(`  → ${created} created${args.dryRun ? ' (dry)' : ''}, ${skipped} skipped, ${failed} failed`);
  return { ok: failed === 0, created, skipped, failed };
}

async function main() {
  console.log(`GHL split-billing field provisioning${args.dryRun ? ' (DRY RUN)' : ''}`);
  console.log(`Schools: ${SCHOOLS.length}`);
  console.log(`Fields per school: ${REQUIRED_FIELDS.length}`);

  let totalCreated = 0, totalSkipped = 0, totalFailed = 0;
  for (const s of SCHOOLS) {
    const r = await provisionForSchool(s);
    totalCreated += r.created ?? 0;
    totalSkipped += r.skipped ?? 0;
    totalFailed  += r.failed  ?? 0;
  }
  console.log(`\nDone. ${totalCreated} created${args.dryRun ? ' (dry)' : ''}, ${totalSkipped} skipped, ${totalFailed} failed across ${SCHOOLS.length} school(s).`);
  if (totalFailed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });

function parseArgs(argv) {
  const out = { dryRun: false, schoolId: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') out.dryRun = true;
    if (argv[i] === '--school-id') out.schoolId = argv[++i];
  }
  return out;
}
