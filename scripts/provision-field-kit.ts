// Provision the Growth Suite Field Kit into a GHL location (CLI wrapper around
// lib/onboarding/provision-field-kit.ts — the same core the one-click
// "Provision & connect" onboarding action uses).
//
// Usage:
//   GHL_KIT_LOCATION=<locationId> GHL_KIT_PIT=<pit-…> npx tsx scripts/provision-field-kit.ts

import { provisionFieldKit } from '../lib/onboarding/provision-field-kit';

const locationId = process.env.GHL_KIT_LOCATION ?? '';
const pit = process.env.GHL_KIT_PIT ?? '';

if (!locationId || !pit) {
  console.error('Set GHL_KIT_LOCATION and GHL_KIT_PIT env vars.');
  process.exit(1);
}

(async () => {
  const r = await provisionFieldKit(locationId, pit, { onLog: (m) => console.log(m) });
  console.log(`\nDone. fields created=${r.created} skipped(existing)=${r.skipped} failed=${r.failed} tags=${r.tagsCreated}`);
  for (const e of r.errors) console.error('  ' + e);
  console.log('Manual (UI-only) steps left: create the admissions pipeline + stages; create a Private Integration Token for the location.');
})().catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
