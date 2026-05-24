// Shared helper: turn a per-widget "family filter" config into a list of
// GHL contacts that count as families for that school.
//
// Per-widget config supports two modes:
//   { kind: 'tag', value: 'enrolled - 26/27' }                — Wooster pattern
//   { kind: 'custom_field_exists', field_key: 'household_id' } — Desert Garden pattern
//
// Phase 2: replace this with family graph as source-of-truth once schools'
// family rows are populated by the intake endpoint.

import type { GhlClient } from '@/lib/ghl/client';
import type { GhlContact } from '@/lib/ghl/contacts';
import { searchContacts } from '@/lib/ghl/contacts';
import { listFields } from '@/lib/field-registry/client';

export type FamilyFilter =
  | { kind: 'tag'; value: string }
  | { kind: 'custom_field_exists'; field_key: string }
  | { kind: 'all' }; // last-resort: every contact is a "family"

export interface FamilyContact {
  contact: GhlContact;
  // Best-effort family display label (parent name + email).
  family_label: string;
}

export async function loadFamilyContacts(
  client: GhlClient,
  schoolId: string,
  filter: FamilyFilter
): Promise<FamilyContact[]> {
  let filters: Array<Record<string, unknown>> | undefined;

  if (filter.kind === 'tag') {
    filters = [{ field: 'tags', operator: 'contains', value: filter.value }];
  } else if (filter.kind === 'custom_field_exists') {
    filters = [{ field: `customField.${filter.field_key}`, operator: 'exists' }];
  } else {
    filters = undefined; // all contacts
  }

  let contacts: GhlContact[];
  try {
    contacts = await searchContacts({ client, filters });
  } catch (err) {
    // If the filter is rejected (some operators aren't supported on every
    // location), fall back to all contacts and filter client-side.
    contacts = await searchContacts({ client });
  }

  // For 'custom_field_exists', double-check client-side that the field is
  // actually populated — the server-side filter sometimes returns broader
  // results than expected.
  if (filter.kind === 'custom_field_exists') {
    const fields = await listFields(schoolId);
    const target = fields.find((f) => f.field_key === filter.field_key);
    if (target) {
      contacts = contacts.filter((c) => {
        const f = c.customFields?.find((cf) => cf.id === target.ghl_field_id);
        if (!f) return false;
        if (f.value === null || f.value === undefined) return false;
        return String(f.value).trim().length > 0;
      });
    }
  }

  return contacts.map((c) => ({
    contact: c,
    family_label: buildFamilyLabel(c),
  }));
}

function buildFamilyLabel(c: GhlContact): string {
  const name = `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim();
  if (name) return name;
  if (c.email) return c.email;
  return `(unnamed contact ${c.id.slice(0, 6)})`;
}
