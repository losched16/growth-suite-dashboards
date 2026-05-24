import type { SchoolContext } from '@/lib/widgets/types';
import type { RecentFormSubmissionsConfig } from './config';
import { loadGhlClient } from '@/lib/ghl/client';
import { getFieldsByKeys, type RegistryField } from '@/lib/field-registry/client';
import { loadFamilyContacts } from '@/lib/widgets/family-source';

export interface RecentSubmission {
  contact_id: string;
  family_label: string;
  email: string;
  form_field_key: string;
  form_display_name: string;
  completed_at: string; // ISO
}

export interface RecentFormSubmissionsData {
  submissions: RecentSubmission[];
  total_seen: number;
  forms_tracked: number;
}

export async function fetcher(
  school: SchoolContext,
  config: RecentFormSubmissionsConfig
): Promise<RecentFormSubmissionsData> {
  const fieldKeys = config.form_field_keys ?? [];
  if (fieldKeys.length === 0) {
    return { submissions: [], total_seen: 0, forms_tracked: 0 };
  }
  const fieldsByKey = await getFieldsByKeys(school.schoolId, fieldKeys);
  const fields: RegistryField[] = fieldKeys
    .map((k) => fieldsByKey.get(k))
    .filter((f): f is RegistryField => Boolean(f));

  if (fields.length === 0) {
    return { submissions: [], total_seen: 0, forms_tracked: 0 };
  }

  const client = await loadGhlClient(school.schoolId);
  const families = await loadFamilyContacts(client, school.schoolId, config.family_filter);

  // Flatten: one entry per (contact, completed-form).
  const all: RecentSubmission[] = [];
  for (const { contact, family_label } of families) {
    for (const f of fields) {
      const cf = contact.customFields?.find((c) => c.id === f.ghl_field_id);
      if (!cf || cf.value === null || cf.value === undefined) continue;
      const raw = String(cf.value).trim();
      if (!raw) continue;
      all.push({
        contact_id: contact.id,
        family_label,
        email: contact.email ?? '',
        form_field_key: f.field_key,
        form_display_name: f.field_name,
        completed_at: raw,
      });
    }
  }

  // Newest first. The DATE values may be ISO strings or epoch — sort by
  // parsed time, fall back to raw lexicographic.
  all.sort((a, b) => {
    const ta = Date.parse(a.completed_at);
    const tb = Date.parse(b.completed_at);
    if (Number.isFinite(ta) && Number.isFinite(tb)) return tb - ta;
    return b.completed_at.localeCompare(a.completed_at);
  });

  const limit = Math.max(1, Math.min(200, config.limit ?? 20));
  return {
    submissions: all.slice(0, limit),
    total_seen: all.length,
    forms_tracked: fields.length,
  };
}
