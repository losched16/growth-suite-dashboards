// Mirror Parent 1's GHL tags onto the promoted Parent 2 contact.
//
// P2 contacts exist for communication: when the office tags Parent 1
// ("Scheduled tour", "enrolled - 26/27"), the co-parent's contact should
// carry the same tag so automations and email segments reach both.
// ADDITIVE only — we add P1 tags that P2 is missing, never remove
// anything from P2 (their own tags, like the 'Parent 2' marker, stay).
//
// Runs from the 15-minute sync for schools with promote_parent2 enabled.
// Diffs are computed from the just-refreshed ghl_contact_tags snapshot,
// so a mirrored tag stops diffing on the next cycle. Contacts that are
// PRIMARY on any family are excluded — a split-household spouse's own
// contact is a real household record, not a communication mirror.

import { query } from '@/lib/db';
import { loadGhlClient } from '@/lib/ghl/client';
import { loadSchoolSettings } from '@/lib/school-settings';

// Marker tags that describe WHICH parent a contact is — never mirrored.
const NO_MIRROR = new Set(['parent 1', 'parent 2']);

export interface MirrorP2TagsResult {
  ran: boolean;
  pairs: number;
  updated: number;
  tags_added: number;
  errors: number;
}

export async function mirrorP2Tags(schoolId: string): Promise<MirrorP2TagsResult> {
  const settings = await loadSchoolSettings(schoolId);
  if (!settings.promote_parent2) {
    return { ran: false, pairs: 0, updated: 0, tags_added: 0, errors: 0 };
  }

  const { rows: pairs } = await query<{ p1: string; p2: string }>(
    `SELECT DISTINCT p1.ghl_contact_id AS p1, p2.ghl_contact_id AS p2
       FROM parents p2
       JOIN parents p1 ON p1.family_id = p2.family_id
                      AND p1.school_id = p2.school_id
                      AND p1.is_primary = true
                      AND p1.ghl_contact_id IS NOT NULL
      WHERE p2.school_id = $1
        AND p2.is_primary = false
        AND p2.status = 'active'
        AND p2.ghl_contact_id IS NOT NULL
        AND p2.ghl_contact_id <> p1.ghl_contact_id
        -- Split households: a contact that is PRIMARY anywhere is a real
        -- household record — leave its tags alone.
        AND NOT EXISTS (
          SELECT 1 FROM parents px
           WHERE px.ghl_contact_id = p2.ghl_contact_id
             AND px.school_id = p2.school_id AND px.is_primary = true
        )`,
    [schoolId],
  );
  const result: MirrorP2TagsResult = { ran: true, pairs: pairs.length, updated: 0, tags_added: 0, errors: 0 };
  if (pairs.length === 0) return result;

  const ids = [...new Set(pairs.flatMap((p) => [p.p1, p.p2]))];
  const { rows: tagRows } = await query<{ ghl_contact_id: string; tag: string }>(
    `SELECT ghl_contact_id, tag FROM ghl_contact_tags
      WHERE school_id = $1 AND ghl_contact_id = ANY($2::text[])`,
    [schoolId, ids],
  );
  const tagsByContact = new Map<string, Set<string>>();
  for (const r of tagRows) {
    if (!tagsByContact.has(r.ghl_contact_id)) tagsByContact.set(r.ghl_contact_id, new Set());
    tagsByContact.get(r.ghl_contact_id)!.add(r.tag.toLowerCase());
  }
  // Preserve original casing for the tags we push.
  const originalCase = new Map<string, string>();
  for (const r of tagRows) originalCase.set(r.tag.toLowerCase(), r.tag);

  let client: Awaited<ReturnType<typeof loadGhlClient>> | null = null;
  for (const pair of pairs) {
    const p1Tags = tagsByContact.get(pair.p1) ?? new Set<string>();
    const p2Tags = tagsByContact.get(pair.p2) ?? new Set<string>();
    const missing = [...p1Tags].filter((t) => !p2Tags.has(t) && !NO_MIRROR.has(t));
    if (missing.length === 0) continue;
    try {
      client ??= await loadGhlClient(schoolId);
      await client.axios.post(`/contacts/${pair.p2}/tags`, {
        tags: missing.map((t) => originalCase.get(t) ?? t),
      });
      // Record locally so the diff disappears immediately (attribute sync
      // re-confirms on the next cycle either way).
      for (const t of missing) {
        await query(
          `INSERT INTO ghl_contact_tags (school_id, ghl_contact_id, tag)
           SELECT $1, $2, $3
            WHERE NOT EXISTS (
              SELECT 1 FROM ghl_contact_tags
               WHERE school_id = $1 AND ghl_contact_id = $2 AND LOWER(tag) = LOWER($3)
            )`,
          [schoolId, pair.p2, originalCase.get(t) ?? t],
        ).catch(() => undefined);
      }
      result.updated++;
      result.tags_added += missing.length;
      await new Promise((r) => setTimeout(r, 120)); // pace GHL writes
    } catch (e) {
      result.errors++;
      console.warn('[mirror-p2-tags] failed for', pair.p2, ':', e instanceof Error ? e.message : String(e));
    }
  }
  return result;
}
