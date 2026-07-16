// GHL Documents & Contracts → Growth Suite tracking.
//
// Schools using GHL's native e-sign for official paperwork (DGM: the AZ
// Emergency Information & Immunization Record Card) name each sent
// document with the student's slot suffix — "AZ Emergency ... Card - S2".
// GHL has no workflow that reliably flips our per-student tracking field
// on completion, so this poller closes the loop:
//
//   1. List the location's documents (GET /proposals/document — the one
//      documents endpoint the standard PIT scopes can read).
//   2. For each status='completed' doc not yet in ghl_document_completions:
//      resolve signer contact → family (the signer may be a P2 contact),
//      parse the "- S{N}" suffix → the family's student with that slot.
//   3. For docs matching a tracked-paperwork rule (AZ card), write
//      "Student {N} AZ Card = Complete" to the family's PRIMARY contact
//      (P1 is the source of truth) and mirror students.metadata so the
//      Portal Forms tracker chip greens immediately.
//
// Phase 2 (blocked on adding the documents-detail scope to the PIT):
// download the signed PDF and file it into student_documents.
//
// Gated on schools.settings.ghl_documents_sync. Idempotent via the
// (school_id, ghl_document_id) ledger. Best-effort: failures log and the
// document retries next cycle (only the ledger insert marks it done).

import { query } from '@/lib/db';
import { loadGhlClient } from '@/lib/ghl/client';
import { loadSchoolSettings } from '@/lib/school-settings';

// Which signed documents flip which per-student tracking field. Kept as a
// module-level rule list until a second school needs a different mapping —
// then this moves into school settings.
const FIELD_RULES: Array<{ pattern: RegExp; field_base: string; value: string }> = [
  { pattern: /emergency.*card/i, field_base: 'az_card', value: 'Complete' },
];

interface GhlDocument {
  _id: string;
  name?: string;
  status?: string;
  deleted?: boolean;
  recipients?: Array<{ id?: string; hasCompleted?: boolean; signedDate?: string }>;
  updatedAt?: string;
}

export interface ImportGhlDocumentsResult {
  ran: boolean;
  completed_seen: number;
  processed: number;
  fields_set: number;
  errors: number;
}

export async function importGhlDocuments(schoolId: string): Promise<ImportGhlDocumentsResult> {
  const result: ImportGhlDocumentsResult = { ran: false, completed_seen: 0, processed: 0, fields_set: 0, errors: 0 };
  const settings = await loadSchoolSettings(schoolId);
  if (!settings.ghl_documents_sync) return result;
  result.ran = true;

  const client = await loadGhlClient(schoolId);
  const docs: GhlDocument[] = [];
  // The endpoint HARD-CAPS limit at ~20 — anything higher silently returns
  // an EMPTY list (limit=100 → zero docs, no error). Page at 20 via skip.
  for (let skip = 0; skip < 1000; skip += 20) {
    const { data } = await client.axios.get<{ documents?: GhlDocument[]; total?: number }>(
      `/proposals/document?locationId=${client.locationId}&limit=20&skip=${skip}`,
    );
    const page = data.documents ?? [];
    docs.push(...page);
    if (page.length < 20 || docs.length >= (data.total ?? docs.length)) break;
  }

  const completed = docs.filter((d) => d.status === 'completed' && !d.deleted);
  result.completed_seen = completed.length;
  if (completed.length === 0) return result;

  // Skip already-processed ones.
  const { rows: seen } = await query<{ ghl_document_id: string }>(
    `SELECT ghl_document_id FROM ghl_document_completions
      WHERE school_id = $1 AND ghl_document_id = ANY($2::text[])`,
    [schoolId, completed.map((d) => d._id)],
  );
  const seenIds = new Set(seen.map((r) => r.ghl_document_id));

  for (const doc of completed) {
    if (seenIds.has(doc._id)) continue;
    try {
      const signer = (doc.recipients ?? []).find((r) => r.hasCompleted) ?? (doc.recipients ?? [])[0];
      const signerContactId = signer?.id ?? null;
      const signedAt = signer?.signedDate ?? doc.updatedAt ?? null;

      // Signer contact → family. The signer may be P1 or a P2 mirror; any
      // parent row on the contact resolves the same family.
      let familyId: string | null = null;
      let primaryContactId: string | null = null;
      if (signerContactId) {
        const { rows: pr } = await query<{ family_id: string }>(
          `SELECT family_id FROM parents
            WHERE school_id = $1 AND ghl_contact_id = $2 AND status = 'active'
            ORDER BY is_primary DESC LIMIT 1`,
          [schoolId, signerContactId],
        );
        familyId = pr[0]?.family_id ?? null;
        if (familyId) {
          const { rows: pri } = await query<{ ghl_contact_id: string | null }>(
            `SELECT ghl_contact_id FROM parents
              WHERE family_id = $1 AND is_primary = true AND ghl_contact_id IS NOT NULL LIMIT 1`,
            [familyId],
          );
          primaryContactId = pri[0]?.ghl_contact_id ?? null;
        }
      }

      // "- S2" suffix → the family's student on that GHL slot.
      const slotMatch = (doc.name ?? '').match(/[-–]\s*S(\d)\s*$/i);
      const slot = slotMatch ? parseInt(slotMatch[1], 10) : null;
      let studentId: string | null = null;
      if (familyId && slot) {
        const { rows: st } = await query<{ id: string }>(
          `SELECT id FROM students
            WHERE family_id = $1 AND status = 'active' AND metadata->>'ghl_slot' = $2
            LIMIT 1`,
          [familyId, String(slot)],
        );
        studentId = st[0]?.id ?? null;
      }

      // Tracking-field flip on the PRIMARY contact.
      let fieldSet = false;
      const rule = FIELD_RULES.find((r) => r.pattern.test(doc.name ?? ''));
      if (rule && slot && primaryContactId) {
        // Field id from the synced catalog (kept fresh by the sync itself).
        const { rows: fld } = await query<{ ghl_field_id: string }>(
          `SELECT ghl_field_id FROM school_field_catalog
            WHERE school_id = $1 AND field_key = $2 LIMIT 1`,
          [schoolId, `student_${slot}_${rule.field_base}`],
        );
        const fieldId = fld[0]?.ghl_field_id ?? null;
        if (fieldId) {
          await client.axios.put(`/contacts/${primaryContactId}`, {
            customFields: [{ id: fieldId, field_value: rule.value }],
          });
          fieldSet = true;
        }
        if (fieldSet && studentId) {
          await query(
            `UPDATE students SET metadata = jsonb_set(metadata, $2::text[], to_jsonb($3::text)), updated_at = now()
              WHERE id = $1`,
            [studentId, `{${rule.field_base}}`, rule.value],
          ).catch(() => undefined);
        }
        if (fieldSet) result.fields_set++;
      }

      await query(
        `INSERT INTO ghl_document_completions
           (school_id, ghl_document_id, document_name, ghl_contact_id, family_id, student_id, signed_at, az_field_set)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT DO NOTHING`,
        [schoolId, doc._id, doc.name ?? '(unnamed)', signerContactId, familyId, studentId, signedAt, fieldSet],
      );
      result.processed++;
      await new Promise((r) => setTimeout(r, 150)); // pace GHL writes
    } catch (e) {
      result.errors++;
      console.warn('[import-ghl-documents] failed for doc', doc._id, ':', e instanceof Error ? e.message : String(e));
    }
  }
  return result;
}
