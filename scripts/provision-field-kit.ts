// Provision the Growth Suite Field Kit into a (fresh) GHL location:
// creates the field folders, every custom field (with picklists), and the
// reserved tags. Idempotent — existing fieldKeys/tags are skipped, so it's
// safe to re-run after a partial failure or to top up an older location.
//
// Usage:
//   GHL_KIT_LOCATION=<locationId> GHL_KIT_PIT=<pit-…> npx tsx scripts/provision-field-kit.ts [--dry-run]
//
// Sequential + paced (150 ms between writes) to stay under GHL's 429 limits.

import axios from 'axios';
import { buildFieldKit, RESERVED_TAGS } from '../lib/onboarding/field-kit';

const locationId = process.env.GHL_KIT_LOCATION ?? '';
const pit = process.env.GHL_KIT_PIT ?? '';
const dryRun = process.argv.includes('--dry-run');

if (!locationId || !pit) {
  console.error('Set GHL_KIT_LOCATION and GHL_KIT_PIT env vars.');
  process.exit(1);
}

const api = axios.create({
  baseURL: 'https://services.leadconnectorhq.com',
  headers: { Authorization: `Bearer ${pit}`, Version: '2021-07-28', Accept: 'application/json' },
  timeout: 15_000,
});
const pause = () => new Promise((r) => setTimeout(r, 150));

// GHL derives the fieldKey from the name: "Student 1 First Name" →
// contact.student_1_first_name. Mirror that to detect existing fields.
const keyFromName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

(async () => {
  // Existing fields (for idempotency)
  const { data: cfData } = await api.get<{ customFields?: Array<{ fieldKey?: string; name?: string }> }>(
    `/locations/${locationId}/customFields`);
  const existingKeys = new Set(
    (cfData.customFields ?? []).map((f) => String(f.fieldKey ?? '').replace(/^contact\./, '')).filter(Boolean));
  console.log(`Location ${locationId}: ${existingKeys.size} existing custom fields`);

  // Folders (documentType: 'folder'), then fields into them.
  const kit = buildFieldKit();
  const folders = [...new Set(kit.map((f) => f.folder))];
  const folderIds = new Map<string, string>();

  for (const folder of folders) {
    if (dryRun) { console.log(`[dry] folder: ${folder}`); continue; }
    try {
      const { data } = await api.post(`/locations/${locationId}/customFields`, {
        name: folder, documentType: 'folder', model: 'contact',
      });
      const id = (data as { customField?: { id?: string }; id?: string })?.customField?.id ?? (data as { id?: string })?.id;
      if (id) folderIds.set(folder, id);
      console.log(`folder created: ${folder}`);
    } catch (e) {
      // Folder may already exist — non-fatal, fields fall back to root.
      console.warn(`folder "${folder}" not created (${axios.isAxiosError(e) ? e.response?.status : e}) — continuing`);
    }
    await pause();
  }

  let created = 0, skipped = 0, failed = 0;
  for (const f of kit) {
    const key = keyFromName(f.name);
    if (existingKeys.has(key)) { skipped++; continue; }
    if (dryRun) { console.log(`[dry] field: ${f.name} [${f.dataType}]${f.options ? ' opts=' + f.options.join('|') : ''}`); created++; continue; }
    try {
      const body: Record<string, unknown> = {
        name: f.name, dataType: f.dataType, model: 'contact',
      };
      if (f.options) body.options = f.options;
      const parentId = folderIds.get(f.folder);
      if (parentId) body.parentId = parentId;
      await api.post(`/locations/${locationId}/customFields`, body);
      created++;
      console.log(`created: ${f.name}`);
    } catch (e) {
      failed++;
      console.error(`FAILED: ${f.name} → ${axios.isAxiosError(e) ? `${e.response?.status} ${JSON.stringify(e.response?.data)}` : e}`);
    }
    await pause();
  }

  // Reserved tags
  for (const tag of RESERVED_TAGS) {
    if (dryRun) { console.log(`[dry] tag: ${tag}`); continue; }
    try {
      await api.post(`/locations/${locationId}/tags`, { name: tag });
      console.log(`tag created: ${tag}`);
    } catch (e) {
      console.warn(`tag "${tag}" not created (may already exist): ${axios.isAxiosError(e) ? e.response?.status : e}`);
    }
    await pause();
  }

  console.log(`\nDone. fields created=${created} skipped(existing)=${skipped} failed=${failed}`);
  console.log('Manual (UI-only) steps left: create the admissions pipeline + stages; create a Private Integration Token for the location.');
})().catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
