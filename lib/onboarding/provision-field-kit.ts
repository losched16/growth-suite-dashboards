// Provision the Growth Suite Field Kit into a GHL location — the reusable
// core shared by the CLI (scripts/provision-field-kit.ts) and the one-click
// "Provision & connect" action on the onboarding board.
//
// Creates the field folders, every custom field (with picklists), and the
// reserved tags. Idempotent — existing fieldKeys/tags are skipped — so it's
// safe to re-run after a partial failure or to top up an older location.
// Sequential + paced (150 ms between writes) to stay under GHL's 429 limits.

import axios from 'axios';
import { buildFieldKit, RESERVED_TAGS } from './field-kit';

export interface ProvisionKitResult {
  existingFields: number;
  created: number;
  skipped: number;
  failed: number;
  foldersCreated: number;
  tagsCreated: number;
  errors: string[];
}

const pause = () => new Promise((r) => setTimeout(r, 150));

// GHL derives the fieldKey from the name: "Student 1 First Name" →
// contact.student_1_first_name. Mirror that to detect existing fields.
const keyFromName = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

export async function provisionFieldKit(
  locationId: string,
  pit: string,
  opts: { onLog?: (msg: string) => void } = {},
): Promise<ProvisionKitResult> {
  const log = opts.onLog ?? (() => undefined);
  const api = axios.create({
    baseURL: 'https://services.leadconnectorhq.com',
    headers: { Authorization: `Bearer ${pit}`, Version: '2021-07-28', Accept: 'application/json' },
    timeout: 15_000,
  });
  const errors: string[] = [];

  // Existing fields (for idempotency).
  const { data: cfData } = await api.get<{ customFields?: Array<{ fieldKey?: string }> }>(
    `/locations/${locationId}/customFields`);
  const existingKeys = new Set(
    (cfData.customFields ?? []).map((f) => String(f.fieldKey ?? '').replace(/^contact\./, '')).filter(Boolean));
  log(`Location has ${existingKeys.size} existing custom fields`);

  // Folders (documentType: 'folder'), then fields into them.
  const kit = buildFieldKit();
  const folders = [...new Set(kit.map((f) => f.folder))];
  const folderIds = new Map<string, string>();
  let foldersCreated = 0;

  for (const folder of folders) {
    try {
      const { data } = await api.post(`/locations/${locationId}/customFields`, {
        name: folder, documentType: 'folder', model: 'contact',
      });
      const id = (data as { customField?: { id?: string }; id?: string })?.customField?.id ?? (data as { id?: string })?.id;
      if (id) { folderIds.set(folder, id); foldersCreated++; }
    } catch {
      // Folder may already exist — non-fatal; fields fall back to root.
    }
    await pause();
  }

  let created = 0, skipped = 0, failed = 0;
  for (const f of kit) {
    const key = keyFromName(f.name);
    if (existingKeys.has(key)) { skipped++; continue; }
    try {
      const body: Record<string, unknown> = { name: f.name, dataType: f.dataType, model: 'contact' };
      if (f.options) body.options = f.options;
      const parentId = folderIds.get(f.folder);
      if (parentId) body.parentId = parentId;
      await api.post(`/locations/${locationId}/customFields`, body);
      created++;
    } catch (e) {
      failed++;
      errors.push(`field "${f.name}": ${axios.isAxiosError(e) ? `${e.response?.status} ${JSON.stringify(e.response?.data)}` : String(e)}`);
    }
    await pause();
  }
  log(`fields: ${created} created, ${skipped} existing, ${failed} failed`);

  // Reserved tags.
  let tagsCreated = 0;
  for (const tag of RESERVED_TAGS) {
    try { await api.post(`/locations/${locationId}/tags`, { name: tag }); tagsCreated++; }
    catch { /* may already exist — non-fatal */ }
    await pause();
  }

  return { existingFields: existingKeys.size, created, skipped, failed, foldersCreated, tagsCreated, errors };
}
