// Resolve a family's GHL attribute values (tags / contact custom
// fields / opportunity info) for display in detail panels. Used by the
// family-detail API behind the roster accordion; reusable by any
// widget that wants "show this GHL field in the dropdown".
//
// Resolution: family → active parents' ghl_contact_ids → the synced
// attribute tables. Multi-value attrs (tags, stages) join with ' · '.

import { query } from '@/lib/db';

export interface ResolvedAttr {
  attr_key: string;
  label: string;
  value: string;
}

export async function resolveFamilyGhlAttrs(
  schoolId: string,
  familyId: string,
  attrKeys: string[],
): Promise<ResolvedAttr[]> {
  if (attrKeys.length === 0) return [];

  const { rows: catalog } = await query<{ attr_key: string; label: string }>(
    `SELECT attr_key, label FROM school_filter_catalog
      WHERE school_id = $1 AND attr_key = ANY($2::text[])`,
    [schoolId, attrKeys],
  );
  if (catalog.length === 0) return [];
  const labelByKey = new Map(catalog.map((c) => [c.attr_key, c.label]));

  const { rows: parentLinks } = await query<{ ghl_contact_id: string }>(
    `SELECT ghl_contact_id FROM parents
      WHERE family_id = $1 AND school_id = $2 AND ghl_contact_id IS NOT NULL AND status = 'active'`,
    [familyId, schoolId],
  );
  const contactIds = parentLinks.map((p) => p.ghl_contact_id);
  if (contactIds.length === 0) return [];

  const out: ResolvedAttr[] = [];
  const wanted = attrKeys.filter((k) => labelByKey.has(k));

  if (wanted.includes('tag')) {
    const { rows } = await query<{ tag: string }>(
      `SELECT DISTINCT tag FROM ghl_contact_tags
        WHERE school_id = $1 AND ghl_contact_id = ANY($2::text[]) ORDER BY tag`,
      [schoolId, contactIds],
    );
    if (rows.length) out.push({ attr_key: 'tag', label: labelByKey.get('tag') ?? 'Tags', value: rows.map((r) => r.tag).join(' · ') });
  }

  const cfKeys = wanted.filter((k) => k.startsWith('cf:')).map((k) => k.slice(3));
  if (cfKeys.length) {
    const { rows } = await query<{ field_key: string; value: string }>(
      `SELECT DISTINCT ON (field_key) field_key, value FROM ghl_contact_field_values
        WHERE school_id = $1 AND ghl_contact_id = ANY($2::text[]) AND field_key = ANY($3::text[])
        ORDER BY field_key, synced_at DESC`,
      [schoolId, contactIds, cfKeys],
    );
    for (const r of rows) {
      const key = `cf:${r.field_key}`;
      out.push({ attr_key: key, label: labelByKey.get(key) ?? r.field_key, value: r.value });
    }
  }

  if (wanted.some((k) => k === 'opp_stage' || k === 'opp_status' || k === 'pipeline')) {
    const { rows } = await query<{ stage_name: string | null; status: string | null; pipeline_name: string | null }>(
      `SELECT stage_name, status, pipeline_name FROM ghl_opportunities
        WHERE school_id = $1 AND ghl_contact_id = ANY($2::text[])`,
      [schoolId, contactIds],
    );
    const stages = [...new Set(rows.map((r) => r.stage_name).filter(Boolean))] as string[];
    const statuses = [...new Set(rows.map((r) => r.status).filter(Boolean))] as string[];
    const pipes = [...new Set(rows.map((r) => r.pipeline_name).filter(Boolean))] as string[];
    if (wanted.includes('opp_stage') && stages.length) out.push({ attr_key: 'opp_stage', label: labelByKey.get('opp_stage') ?? 'Opportunity stage', value: stages.join(' · ') });
    if (wanted.includes('opp_status') && statuses.length) out.push({ attr_key: 'opp_status', label: labelByKey.get('opp_status') ?? 'Opportunity status', value: statuses.join(' · ') });
    if (wanted.includes('pipeline') && pipes.length) out.push({ attr_key: 'pipeline', label: labelByKey.get('pipeline') ?? 'Pipeline', value: pipes.join(' · ') });
  }

  // Preserve the school's configured order.
  out.sort((a, b) => attrKeys.indexOf(a.attr_key) - attrKeys.indexOf(b.attr_key));
  return out;
}
