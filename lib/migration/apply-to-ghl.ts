// Apply a reviewed CSV migration INTO a school's GHL sub-account.
//
// ⚠️ LIVE GHL WRITE. Hard-gated: a school can only COMMIT if its GHL location
// id is listed in CSV_MIGRATION_ALLOW_LOCATIONS (comma-separated). Unset ⇒
// commit is disabled for EVERY school — the dry-run plan still works. This is
// the guardrail that keeps real schools (DGM, MCH, …) safe while the writer is
// validated on GS Test only. Must be exercised against a real sub-account from
// the desktop before the flag is turned on for anyone.

import { loadGhlClient } from '@/lib/ghl/client';
import { findContactByEmail } from '@/lib/ghl/contacts';
import { resolveContactPayloads, type MappingRow } from './csv-mapping';

export function commitAllowedFor(ghlLocationId: string | null | undefined): boolean {
  const raw = process.env.CSV_MIGRATION_ALLOW_LOCATIONS ?? '';
  if (!raw.trim() || !ghlLocationId) return false;
  return raw.split(',').map((s) => s.trim()).filter(Boolean).includes(ghlLocationId);
}

export interface ApplyRowResult {
  rowIndex: number;
  name: string;
  email: string;
  action: 'created' | 'updated' | 'error';
  contactId?: string;
  error?: string;
}
export interface ApplyResult {
  attempted: number;
  created: number;
  updated: number;
  errors: number;
  results: ApplyRowResult[];
}

// Upsert each resolved contact by email (create when new). Custom fields are
// written by GHL field id. `limit` caps how many rows are pushed (used for a
// small first-run smoke test).
export async function applyMigrationToGhl(
  schoolId: string,
  rows: Array<Record<string, string>>,
  mapping: MappingRow[],
  opts?: { limit?: number },
): Promise<ApplyResult> {
  const { payloads } = resolveContactPayloads(rows, mapping);
  const slice = opts?.limit && opts.limit > 0 ? payloads.slice(0, opts.limit) : payloads;
  const client = await loadGhlClient(schoolId);

  let created = 0, updated = 0, errors = 0;
  const results: ApplyRowResult[] = [];
  for (const p of slice) {
    const name = `${p.firstName} ${p.lastName}`.trim();
    const customFields = p.customFields.map((cf) => ({ id: cf.id, field_value: cf.value }));
    try {
      const existing = p.email ? await findContactByEmail(client, p.email) : null;
      if (existing) {
        const body: Record<string, unknown> = { customFields };
        if (p.firstName) body.firstName = p.firstName;
        if (p.lastName) body.lastName = p.lastName;
        if (p.phone) body.phone = p.phone;
        await client.axios.put(`/contacts/${existing.id}`, body);
        updated++;
        results.push({ rowIndex: p.rowIndex, name, email: p.email, action: 'updated', contactId: existing.id });
      } else {
        const body: Record<string, unknown> = { locationId: client.locationId, customFields };
        if (p.firstName) body.firstName = p.firstName;
        if (p.lastName) body.lastName = p.lastName;
        if (p.email) body.email = p.email;
        if (p.phone) body.phone = p.phone;
        const { data } = await client.axios.post<{ contact?: { id?: string } }>('/contacts/', body);
        created++;
        results.push({ rowIndex: p.rowIndex, name, email: p.email, action: 'created', contactId: data?.contact?.id });
      }
    } catch (e) {
      errors++;
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message
        ?? (e instanceof Error ? e.message : String(e));
      results.push({ rowIndex: p.rowIndex, name, email: p.email, action: 'error', error: String(msg).slice(0, 300) });
    }
  }
  return { attempted: slice.length, created, updated, errors, results };
}
