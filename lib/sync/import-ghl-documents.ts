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
// missing_value: what an enrolled student's tracking field is set to when
// NO completed document exists — smart lists filter on it ("Not Complete").
// Without it non-submitters just have an EMPTY field, which a picklist
// smart-list filter can't catch.
const FIELD_RULES: Array<{ pattern: RegExp; field_base: string; value: string; missing_value: string }> = [
  { pattern: /emergency.*card/i, field_base: 'az_card', value: 'Complete', missing_value: 'Not Complete' },
];

interface GhlDocument {
  _id: string;
  name?: string;
  status?: string;
  deleted?: boolean;
  recipients?: Array<{ id?: string; hasCompleted?: boolean; signedDate?: string }>;
  fillableFields?: Array<{ fieldId?: string; type?: string; value?: unknown }>;
  updatedAt?: string;
}

// AZ Emergency Card layout (verified against DGM's signed cards): the
// "person(s) who will accept responsibility for the child / to whom the
// child may be released" section is text_field_17..20 (names) paired
// positionally with text_field_21..24 (phones). These become authorized
// pickup people scoped to the card's student.
const CARD_PICKUP_PAIRS: Array<[string, string]> = [
  ['text_field_17', 'text_field_21'],
  ['text_field_18', 'text_field_22'],
  ['text_field_19', 'text_field_23'],
  ['text_field_20', 'text_field_24'],
];
const cleanCardText = (s: unknown): string =>
  String(s ?? '').replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
const normCardName = (s: string): string => cleanCardText(s).toLowerCase().replace(/[^a-z]/g, '');
const isCardJunk = (s: string): boolean => s === '' || /^(na|n\/?a|none|nil|-+|\.+)$/i.test(s);

// Small Levenshtein for name-variant tolerance (Londyn/London). Inputs
// are short normalized first names, so the O(n\u00B7m) matrix is fine.
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0 || n === 0) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// Emergency/release-to people from a signed card → pickup_persons rows
// scoped to the card's student. Skips the family's own parents, junk
// entries, and anyone already on the family's pickup list (any source).
async function importCardPickupPeople(
  schoolId: string,
  familyId: string,
  studentId: string | null,
  doc: GhlDocument,
  // The card SIGNER owns the people it names (split households keep
  // separate lists; the portal hides them from the other household).
  signerParentId: string | null,
): Promise<number> {
  const fieldVal = (fid: string): string => {
    const f = (doc.fillableFields ?? []).find((x) => x.fieldId === fid && x.type !== 'Checkbox');
    return f ? cleanCardText(f.value) : '';
  };
  const { rows: fam } = await query<{ id: string; is_primary: boolean; first_name: string; last_name: string }>(
    `SELECT id, is_primary, first_name, last_name FROM parents
      WHERE family_id = $1 AND status = 'active'`, [familyId]);
  if (fam.length === 0) return 0;
  const parentNorms = new Set(fam.map((p) => normCardName(`${p.first_name} ${p.last_name}`)));
  for (const fid of ['text_field_8', 'text_field_16', 'text_field_27']) {
    const v = fieldVal(fid);
    if (v) parentNorms.add(normCardName(v));
  }
  const p1 = fam.find((p) => p.is_primary) ?? fam[0];
  const owner = (signerParentId && fam.some((p) => p.id === signerParentId))
    ? fam.find((p) => p.id === signerParentId)! : p1;
  // Dedupe PER OWNER (matches the per-owner unique index): each
  // household keeps its own copy of a shared grandma.
  const { rows: existing } = await query<{ id: string; name: string }>(
    `SELECT id, name FROM pickup_persons WHERE family_id = $1 AND added_by_parent_id = $2`,
    [familyId, owner.id]);
  const existingByNorm = new Map(existing.map((e) => [normCardName(e.name), e.id]));

  let added = 0;
  for (const [nf, pf] of CARD_PICKUP_PAIRS) {
    const name = fieldVal(nf);
    if (isCardJunk(name) || parentNorms.has(normCardName(name))) continue;
    const phone = fieldVal(pf);
    let ppId = existingByNorm.get(normCardName(name)) ?? null;
    if (!ppId) {
      const { rows: ins } = await query<{ id: string }>(
        `INSERT INTO pickup_persons (school_id, family_id, added_by_parent_id, name, relationship, phone, notes, active, is_temporary)
         VALUES ($1, $2, $3, $4, 'Emergency card contact', $5, 'Imported from signed AZ Emergency Card', true, false)
         RETURNING id`,
        [schoolId, familyId, owner.id, name, isCardJunk(phone) ? null : phone]);
      ppId = ins[0].id;
      existingByNorm.set(normCardName(name), ppId);
      added++;
    }
    if (studentId) {
      await query(
        `INSERT INTO pickup_person_students (pickup_person_id, student_id, school_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [ppId, studentId, schoolId]);
    }
  }
  return added;
}

export interface ImportGhlDocumentsResult {
  ran: boolean;
  completed_seen: number;
  processed: number;
  fields_set: number;
  not_complete_set: number;
  pickup_people_added: number;
  errors: number;
}

export async function importGhlDocuments(schoolId: string): Promise<ImportGhlDocumentsResult> {
  const result: ImportGhlDocumentsResult = { ran: false, completed_seen: 0, processed: 0, fields_set: 0, not_complete_set: 0, pickup_people_added: 0, errors: 0 };
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
  if (completed.length === 0) {
    await reconcileMissingCards(schoolId, client, result);
    return result;
  }

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

      // Which student is this card for? Trust the child NAME written on
      // the card first — the office's "- S2" numbering doesn't always
      // match the contact's slot numbering (the Darling family's cards
      // were numbered opposite to their slots, which crossed the two
      // kids' allergies; a parent also filled both kids' links with the
      // SAME child once). The suffix is only a fallback for cards whose
      // name field is blank; a name that matches NO student (test cards
      // like "Sunny Days") resolves to nothing and stamps nothing.
      const suffixMatch = (doc.name ?? '').match(/[-–]\s*S(\d)\s*$/i);
      const suffixSlot = suffixMatch ? parseInt(suffixMatch[1], 10) : null;
      const cardChild = String(
        ((doc.fillableFields ?? []).find((f) => f.fieldId === 'text_field_1' && f.type === 'TextField') ?? {}).value ?? '',
      ).trim().split(/\s+/)[0] ?? '';
      let studentId: string | null = null;
      let slot: number | null = null;
      if (familyId) {
        const { rows: kids } = await query<{ id: string; first_name: string; slot: string | null }>(
          `SELECT id, first_name, metadata->>'ghl_slot' AS slot
             FROM students WHERE family_id = $1 AND status = 'active'`,
          [familyId],
        );
        const cn = normCardName(cardChild);
        const similar = (a: string, b: string) =>
          a === b || (a.length >= 3 && b.startsWith(a)) || (b.length >= 3 && a.startsWith(b)) || editDistance(a, b) <= 2;
        const named = cn ? kids.filter((k) => similar(normCardName(k.first_name), cn)) : [];
        let pick = named.length === 1 ? named[0]
          : named.length > 1 ? (named.find((k) => k.slot === String(suffixSlot)) ?? named[0])
          : null;
        if (!pick && !cn && suffixSlot) {
          // Blank name field — legacy suffix behavior.
          pick = kids.find((k) => k.slot === String(suffixSlot)) ?? null;
        }
        if (pick) {
          studentId = pick.id;
          slot = pick.slot ? parseInt(pick.slot, 10) : suffixSlot;
        } else if (cn) {
          console.warn(`[import-ghl-documents] card "${doc.name}" child "${cardChild}" matches no student in family ${familyId} — not stamped`);
        }
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
        if (familyId) {
          const { rows: signerRow } = await query<{ id: string }>(
            `SELECT id FROM parents WHERE family_id = $1 AND ghl_contact_id = $2 AND status = 'active' LIMIT 1`,
            [familyId, signerContactId]);
          result.pickup_people_added += await importCardPickupPeople(schoolId, familyId, studentId, doc, signerRow[0]?.id ?? null)
            .catch((e) => { console.warn('[import-ghl-documents] pickup import failed for doc', doc._id, ':', e instanceof Error ? e.message : String(e)); return 0; });
        }
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
  await reconcileMissingCards(schoolId, client, result);
  return result;
}

// Enrolled students with NO value in their tracking field get the rule's
// missing_value ("Not Complete") so office smart lists can target
// non-submitters by picklist option. students.metadata mirrors the contact
// field via the regular sync, so a NULL there means "field empty as of the
// last sync" — we re-check the LIVE contact before writing, so a value the
// office set by hand minutes ago is never clobbered (we mirror it instead,
// which also stops the row from re-qualifying here). Capped per run; the
// one-time backfill handles the bulk, this keeps NEW students stamped.
async function reconcileMissingCards(
  schoolId: string,
  client: Awaited<ReturnType<typeof loadGhlClient>>,
  result: ImportGhlDocumentsResult,
): Promise<void> {
  for (const rule of FIELD_RULES) {
    try {
      const { rows: missing } = await query<{ id: string; slot: string; ghl_contact_id: string }>(
        `SELECT st.id, st.metadata->>'ghl_slot' AS slot, p.ghl_contact_id
           FROM students st
           JOIN families f ON f.id = st.family_id
           JOIN parents p ON p.family_id = f.id AND p.is_primary = true
                         AND p.status = 'active' AND p.ghl_contact_id IS NOT NULL
          WHERE f.school_id = $1 AND st.status = 'active'
            AND st.metadata->>'ghl_slot' IS NOT NULL
            AND COALESCE(st.metadata->>$2, '') = ''
          LIMIT 40`,
        [schoolId, rule.field_base],
      );
      if (missing.length === 0) continue;

      // One contact fetch per family even with several unstamped kids.
      const contactFields = new Map<string, Map<string, string>>();
      for (const m of missing) {
        const fieldKey = `student_${m.slot}_${rule.field_base}`;
        const { rows: fld } = await query<{ ghl_field_id: string }>(
          `SELECT ghl_field_id FROM school_field_catalog
            WHERE school_id = $1 AND field_key = $2 LIMIT 1`,
          [schoolId, fieldKey],
        );
        const fieldId = fld[0]?.ghl_field_id ?? null;
        if (!fieldId) continue; // no such field for this slot — nothing to stamp

        let byFieldId = contactFields.get(m.ghl_contact_id);
        if (!byFieldId) {
          const { data } = await client.axios.get<{
            contact?: { customFields?: Array<{ id: string; value?: unknown }> };
          }>(`/contacts/${m.ghl_contact_id}`);
          byFieldId = new Map(
            (data.contact?.customFields ?? []).map((cf) => [cf.id, cf.value == null ? '' : String(cf.value)]),
          );
          contactFields.set(m.ghl_contact_id, byFieldId);
        }

        const current = (byFieldId.get(fieldId) ?? '').trim();
        if (current === '') {
          await client.axios.put(`/contacts/${m.ghl_contact_id}`, {
            customFields: [{ id: fieldId, field_value: rule.missing_value }],
          });
          result.not_complete_set++;
        }
        // Mirror contact truth onto the student row either way.
        await query(
          `UPDATE students SET metadata = jsonb_set(metadata, $2::text[], to_jsonb($3::text)), updated_at = now()
            WHERE id = $1`,
          [m.id, `{${rule.field_base}}`, current === '' ? rule.missing_value : current],
        ).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 150)); // pace GHL calls
      }
    } catch (e) {
      result.errors++;
      console.warn('[import-ghl-documents] reconcile failed:', e instanceof Error ? e.message : String(e));
    }
  }
}
