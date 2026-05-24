import type { SchoolContext } from '@/lib/widgets/types';
import type { FormCompletionGridConfig } from './config';
import { loadGhlClient } from '@/lib/ghl/client';
import { getFieldsByKeys, type RegistryField } from '@/lib/field-registry/client';
import { loadFamilyContacts } from '@/lib/widgets/family-source';

export interface FormColumn {
  field_key: string;
  display_name: string;
  ghl_field_id: string;
}

export interface FamilyRow {
  contact_id: string;
  family_label: string;
  email: string;
  // For each form column, completedAt date string ('' if pending).
  completion: Record<string, string>;
  completed_count: number;
  total_count: number;
}

export interface FormCompletionGridData {
  forms: FormColumn[];
  rows: FamilyRow[];
  totals: {
    families: number;
    forms_per_family: number;
    fully_complete_families: number;
  };
}

export async function fetcher(
  school: SchoolContext,
  config: FormCompletionGridConfig
): Promise<FormCompletionGridData> {
  const fieldKeys = config.form_field_keys ?? [];
  if (fieldKeys.length === 0) {
    return {
      forms: [],
      rows: [],
      totals: { families: 0, forms_per_family: 0, fully_complete_families: 0 },
    };
  }

  // Resolve registry field rows so we know each form's display name + GHL id.
  const fieldsByKey = await getFieldsByKeys(school.schoolId, fieldKeys);
  const forms: FormColumn[] = fieldKeys
    .map((k) => fieldsByKey.get(k))
    .filter((f): f is RegistryField => Boolean(f))
    .map((f) => ({
      field_key: f.field_key,
      display_name: f.field_name,
      ghl_field_id: f.ghl_field_id,
    }));

  if (forms.length === 0) {
    return {
      forms: [],
      rows: [],
      totals: { families: 0, forms_per_family: 0, fully_complete_families: 0 },
    };
  }

  const client = await loadGhlClient(school.schoolId);
  const families = await loadFamilyContacts(client, school.schoolId, config.family_filter);

  const rows: FamilyRow[] = families.map(({ contact, family_label }) => {
    const completion: Record<string, string> = {};
    let completedCount = 0;
    for (const f of forms) {
      const cf = contact.customFields?.find((c) => c.id === f.ghl_field_id);
      const raw = cf && cf.value !== null && cf.value !== undefined ? String(cf.value).trim() : '';
      completion[f.field_key] = raw;
      if (raw) completedCount++;
    }
    return {
      contact_id: contact.id,
      family_label,
      email: contact.email ?? '',
      completion,
      completed_count: completedCount,
      total_count: forms.length,
    };
  });

  const filtered = config.min_incomplete > 0
    ? rows.filter((r) => r.total_count - r.completed_count >= config.min_incomplete)
    : rows;

  const fullyComplete = rows.filter((r) => r.completed_count === r.total_count).length;

  return {
    forms,
    rows: filtered,
    totals: {
      families: rows.length,
      forms_per_family: forms.length,
      fully_complete_families: fullyComplete,
    },
  };
}
