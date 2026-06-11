// Additive GHL attribute sync — the data layer behind self-serve
// filters. Pulls every contact's tags + custom-field values + all
// opportunities from GHL and refreshes four derived tables:
//
//   ghl_contact_tags          (contact → tag)
//   ghl_contact_field_values  (contact → field_key → value)
//   ghl_opportunities         (contact → pipeline/stage/status/value)
//   school_filter_catalog     (every filterable attribute + samples)
//
// NEVER touches families/students/parents/enrollments — safe for
// schools whose roster is DB-managed (sync_mode='attributes_only').
// Runs for every school from the 6-hour cron regardless of sync_mode
// (except 'off'), since the attribute layer is read-model only.

import { query, withTransaction } from '@/lib/db';
import { loadGhlClient, type GhlClient } from '@/lib/ghl/client';
import { searchContacts, type GhlContact } from '@/lib/ghl/contacts';
import { fetchPipelines, fetchAllOpportunities, buildStageLookup } from '@/lib/ghl/pipelines';

export interface AttributeSyncResult {
  contacts: number;
  tag_rows: number;
  field_value_rows: number;
  opportunities: number;
  catalog_attributes: number;
}

interface CfDef { key: string; label: string; dataType: string }

function valToStr(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(valToStr).filter(Boolean).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v).trim();
}

function inferType(def: CfDef, values: Set<string>): string {
  const dt = (def.dataType || '').toUpperCase();
  if (dt.includes('OPTION') || dt.includes('CHECKBOX') || dt.includes('RADIO')) return 'select';
  if (dt.includes('NUMER') || dt.includes('MONET')) return 'number';
  if (dt.includes('DATE')) return 'date';
  const arr = [...values];
  if (arr.length && arr.every((v) => /^-?\d+(\.\d+)?$/.test(v))) return 'number';
  if (arr.length && arr.length <= 40) return 'select';
  return 'text';
}

export async function syncGhlAttributes(schoolId: string): Promise<AttributeSyncResult> {
  const client: GhlClient = await loadGhlClient(schoolId);

  // 1. Custom-field definitions: id → { key, label, dataType }
  const { data: cfData } = await client.axios.get<{ customFields?: Array<{ id: string; fieldKey?: string; name?: string; dataType?: string }> }>(
    `/locations/${client.locationId}/customFields`,
  );
  const cfDefs = new Map<string, CfDef>();
  for (const f of cfData.customFields ?? []) {
    const key = (f.fieldKey ?? '').replace(/^contact\./, '');
    if (key) cfDefs.set(f.id, { key, label: f.name ?? key, dataType: f.dataType ?? 'TEXT' });
  }

  // 2. All contacts (tags + custom field values come along)
  const contacts: GhlContact[] = await searchContacts({ client });

  // 3. Pipelines + opportunities (best-effort — some locations have none)
  let stageLookup = new Map<string, { stageName: string; pipelineName: string; pipelineId: string }>();
  let opps: Awaited<ReturnType<typeof fetchAllOpportunities>> = [];
  try {
    const pipelines = await fetchPipelines(client);
    stageLookup = buildStageLookup(pipelines);
    opps = await fetchAllOpportunities(client);
  } catch (err) {
    console.warn('[ghl-attributes] pipelines/opps fetch failed:', err instanceof Error ? err.message : String(err));
  }

  // 4. Build rows in memory
  const tagRows: Array<[string, string]> = [];           // [contact_id, tag]
  const cfvRows: Array<[string, string, string]> = [];   // [contact_id, key, value]
  const tagSet = new Set<string>();
  const cfAgg = new Map<string, { def: CfDef; values: Set<string>; count: number }>();
  for (const ct of contacts) {
    for (const tg of ct.tags ?? []) {
      const t = valToStr(tg);
      if (!t) continue;
      tagRows.push([ct.id, t]);
      tagSet.add(t);
    }
    for (const cf of ct.customFields ?? []) {
      const def = cfDefs.get(cf.id);
      if (!def) continue;
      const v = valToStr(cf.value);
      if (!v) continue;
      cfvRows.push([ct.id, def.key, v.slice(0, 2000)]);
      let agg = cfAgg.get(def.key);
      if (!agg) { agg = { def, values: new Set(), count: 0 }; cfAgg.set(def.key, agg); }
      agg.count++;
      if (agg.values.size < 200) agg.values.add(v);
    }
  }
  const stageSet = new Set<string>();
  const statusSet = new Set<string>();
  const pipeSet = new Set<string>();
  for (const o of opps) {
    const info = stageLookup.get(o.pipelineStageId);
    if (info) { stageSet.add(info.stageName); pipeSet.add(info.pipelineName); }
    if (o.status) statusSet.add(o.status);
  }

  // 5. Catalog
  const catalog: Array<[string, string, string, string | null, string, string, number]> = [];
  if (tagSet.size) catalog.push(['tag', 'tag', 'Tags', null, 'multi', JSON.stringify([...tagSet].sort()), tagRows.length]);
  for (const [key, agg] of cfAgg) {
    const type = inferType(agg.def, agg.values);
    const samples = type === 'select' ? [...agg.values].sort() : [...agg.values].slice(0, 20);
    catalog.push([`cf:${key}`, 'custom_field', agg.def.label, null, type, JSON.stringify(samples), agg.count]);
  }
  if (stageSet.size) catalog.push(['opp_stage', 'opportunity_stage', 'Opportunity stage', null, 'select', JSON.stringify([...stageSet].sort()), opps.length]);
  if (statusSet.size) catalog.push(['opp_status', 'opportunity_status', 'Opportunity status', null, 'select', JSON.stringify([...statusSet].sort()), opps.length]);
  if (pipeSet.size) catalog.push(['pipeline', 'pipeline', 'Pipeline', null, 'select', JSON.stringify([...pipeSet].sort()), opps.length]);

  // 6. Persist — full refresh of the derived tables in one transaction.
  await withTransaction(async (q) => {
    await q(`DELETE FROM ghl_contact_tags WHERE school_id = $1`, [schoolId]);
    await q(`DELETE FROM ghl_contact_field_values WHERE school_id = $1`, [schoolId]);
    await q(`DELETE FROM ghl_opportunities WHERE school_id = $1`, [schoolId]);
    await q(`DELETE FROM school_filter_catalog WHERE school_id = $1`, [schoolId]);

    for (let i = 0; i < tagRows.length; i += 500) {
      const chunk = tagRows.slice(i, i + 500);
      const placeholders = chunk.map((_, j) => `($1, $${j * 2 + 2}, $${j * 2 + 3})`).join(',');
      await q(
        `INSERT INTO ghl_contact_tags (school_id, ghl_contact_id, tag) VALUES ${placeholders} ON CONFLICT DO NOTHING`,
        [schoolId, ...chunk.flat()],
      );
    }
    for (let i = 0; i < cfvRows.length; i += 300) {
      const chunk = cfvRows.slice(i, i + 300);
      const placeholders = chunk.map((_, j) => `($1, $${j * 3 + 2}, $${j * 3 + 3}, $${j * 3 + 4})`).join(',');
      await q(
        `INSERT INTO ghl_contact_field_values (school_id, ghl_contact_id, field_key, value) VALUES ${placeholders}
         ON CONFLICT (school_id, ghl_contact_id, field_key) DO UPDATE SET value = EXCLUDED.value, synced_at = now()`,
        [schoolId, ...chunk.flat()],
      );
    }
    for (const o of opps) {
      const info = stageLookup.get(o.pipelineStageId);
      await q(
        `INSERT INTO ghl_opportunities (id, school_id, ghl_contact_id, pipeline_id, pipeline_name, stage_id, stage_name, status, monetary_value, last_stage_change_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (id) DO UPDATE SET stage_name = EXCLUDED.stage_name, status = EXCLUDED.status,
           monetary_value = EXCLUDED.monetary_value, synced_at = now()`,
        [o.id, schoolId, o.contactId ?? null, o.pipelineId ?? null, info?.pipelineName ?? null,
         o.pipelineStageId ?? null, info?.stageName ?? null, o.status ?? null,
         o.monetaryValue ?? null, o.lastStageChangeAt ?? null],
      );
    }
    for (const row of catalog) {
      await q(
        `INSERT INTO school_filter_catalog (school_id, attr_key, attr_type, label, ghl_field_id, data_type, sample_values, value_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
        [schoolId, ...row],
      );
    }
  });

  return {
    contacts: contacts.length,
    tag_rows: tagRows.length,
    field_value_rows: cfvRows.length,
    opportunities: opps.length,
    catalog_attributes: catalog.length,
  };
}
