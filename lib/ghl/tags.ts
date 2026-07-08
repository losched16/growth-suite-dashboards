import { loadGhlClient } from '@/lib/ghl/client';

// EVERY tag defined in the GHL location. Used to populate the form-targeting
// "show by tag" / "hide by tag" pickers so a school can target ANY tag in the
// system — not just tags that happen to be on an already-synced contact (which
// is all `ghl_contact_tags` holds). Callers union this with the seen-on-contacts
// list. Best-effort: returns [] on any failure so the picker still works.
export async function loadGhlLocationTags(schoolId: string): Promise<string[]> {
  try {
    const client = await loadGhlClient(schoolId);
    const { data } = await client.axios.get<{ tags?: unknown[] }>(
      `/locations/${client.locationId}/tags`,
    );
    return (data.tags ?? [])
      .map((t) => (typeof t === 'string' ? t : String((t as { name?: string })?.name ?? '')).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}
