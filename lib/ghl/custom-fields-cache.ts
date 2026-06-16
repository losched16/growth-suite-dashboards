// In-process cache of GHL custom-field id ↔ fieldKey for a location.
//
// Background: the webhook resolver originally read these from a
// `ghl_attributes_catalog` table that was never created in prod — so
// the cascade to student_first_name, parent_2_first_name etc. silently
// no-op'd. This module bypasses the catalog and hits GHL directly
// (with a 5-minute in-memory cache so the webhook stays fast).
//
// One cache per locationId. TTL deliberately short — schools rarely
// add custom fields, but when they do we don't want a process restart
// to be the only way to pick them up.

import type { GhlClient } from './client';

interface CustomFieldDef {
  id: string;
  name?: string;
  fieldKey?: string;
  key?: string;
}

const TTL_MS = 5 * 60_000;

const cache = new Map<string, { at: number; byKey: Map<string, string> }>();

// Returns a Map<normalized fieldKey, ghl_field_id>. The key is
// stripped of any "contact." prefix so callers can look up by the
// short name (e.g. "parent_2_first_name" not "contact.parent_2_first_name").
export async function loadFieldKeyMap(client: GhlClient): Promise<Map<string, string>> {
  const cached = cache.get(client.locationId);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.byKey;

  const { data } = await client.axios.get<{ customFields?: CustomFieldDef[] }>(
    `/locations/${client.locationId}/customFields`,
  );
  const byKey = new Map<string, string>();
  for (const f of data.customFields ?? []) {
    const raw = f.fieldKey ?? f.key;
    if (!raw || !f.id) continue;
    const norm = raw.startsWith('contact.') ? raw.slice('contact.'.length) : raw;
    byKey.set(norm, f.id);
  }
  cache.set(client.locationId, { at: Date.now(), byKey });
  return byKey;
}
