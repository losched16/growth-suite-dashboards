// Collapse duplicate pipeline cards for the same student.
//
// Schools whose GHL account has two workflows creating a card off the same
// form submission end up with pairs like "Madison " + "Madison Murphy" (one
// workflow fires the instant the first name saves, before the last name
// lands), and tour workflows that open a second "Paisley Thomas " card
// instead of moving the first. Wooster, Aug–Oct 2026: every new inquiry.
//
// A cluster = open cards on ONE contact in ONE pipeline that are the same
// student: identical once whitespace/case are normalised, or a first-name-
// only card whose name is the first word of exactly one full-name card on
// that contact (so siblings can't be merged into each other).
//
// Per cluster, the card furthest along the pipeline is KEPT (no stage move —
// moving would fire the school's stage-change workflows a second time), it is
// renamed to the full name if needed, picks up custom-field values and an
// owner only the duplicates had, and the duplicates are deleted. Clusters
// touched in the last few minutes are left for the next run (a workflow may
// still be mid-flight, or the office mid-edit).
//
// Opt-in per school: settings.dedupe_partial_opportunities = true.

import type { GhlClient } from '@/lib/ghl/client';
import { loadGhlClient } from '@/lib/ghl/client';
import { fetchAllOpportunities, fetchPipelines, type Opportunity } from '@/lib/ghl/pipelines';

const SETTLE_MS = 5 * 60 * 1000;

type Opp = Opportunity & { assignedTo?: string | null };

export interface DedupeMerge {
  contact_id: string;
  kept: { id: string; name: string; stage: string; renamed_from?: string };
  deleted: Array<{ id: string; name: string; stage: string }>;
  fields_copied: number;
}

export interface DedupeResult {
  cards_scanned: number;
  clusters: number;
  merges: DedupeMerge[];
  skipped_recent: number;
  skipped_ambiguous: number;
  errors: string[];
}

const norm = (s: string | undefined) =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
const tidy = (s: string | undefined) => String(s ?? '').replace(/\s+/g, ' ').trim();

function fieldValue(cf: NonNullable<Opportunity['customFields']>[number]): string | null {
  if (typeof cf.fieldValueString === 'string' && cf.fieldValueString !== '') return cf.fieldValueString;
  if (typeof cf.fieldValueDate === 'number') return new Date(cf.fieldValueDate).toISOString().slice(0, 10);
  if (typeof cf.fieldValue === 'string' && cf.fieldValue !== '') return cf.fieldValue;
  return null;
}

export async function dedupePartialOpportunities(
  schoolId: string,
  opts?: { dryRun?: boolean; client?: GhlClient },
): Promise<DedupeResult> {
  const client = opts?.client ?? (await loadGhlClient(schoolId));
  const [pipelines, all] = await Promise.all([fetchPipelines(client), fetchAllOpportunities(client)]);
  const stagePos = new Map<string, number>();
  const stageName = new Map<string, string>();
  for (const p of pipelines) {
    p.stages.forEach((s, i) => { stagePos.set(s.id, s.position ?? i); stageName.set(s.id, s.name); });
  }

  const result: DedupeResult = { cards_scanned: all.length, clusters: 0, merges: [], skipped_recent: 0, skipped_ambiguous: 0, errors: [] };
  const groups = new Map<string, Opp[]>();
  for (const o of all as Opp[]) {
    if (o.status !== 'open' || !o.contactId || !norm(o.name)) continue;
    const k = `${o.contactId}|${o.pipelineId}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(o);
  }

  for (const cards of groups.values()) {
    if (cards.length < 2) continue;
    const fullNames = [...new Set(cards.map((c) => norm(c.name)).filter((n) => n.includes(' ')))];
    const clusters = new Map<string, Opp[]>(); // full normalised name → cards
    for (const c of cards) {
      const n = norm(c.name);
      if (n.includes(' ')) { (clusters.get(n) ?? clusters.set(n, []).get(n)!).push(c); continue; }
      const owners = fullNames.filter((f) => f.split(' ')[0] === n);
      if (owners.length === 1) (clusters.get(owners[0]) ?? clusters.set(owners[0], []).get(owners[0])!).push(c);
      else if (owners.length > 1) result.skipped_ambiguous++;
    }

    for (const [full, members] of clusters) {
      if (members.length < 2) continue;
      result.clusters++;
      const newest = Math.max(...members.map((m) => Date.parse(m.updatedAt ?? m.createdAt ?? '') || 0));
      if (Date.now() - newest < SETTLE_MS) { result.skipped_recent++; continue; }

      // canonical display name: a full-name card's name, preferring one that
      // was already typed cleanly (no stray spaces)
      const fullCards = members.filter((m) => norm(m.name) === full);
      const canonical = tidy((fullCards.find((m) => m.name === tidy(m.name)) ?? fullCards[0]).name);
      const ranked = [...members].sort((a, b) =>
        ((stagePos.get(b.pipelineStageId) ?? -1) - (stagePos.get(a.pipelineStageId) ?? -1))
        || (Number(tidy(b.name) === canonical) - Number(tidy(a.name) === canonical))
        || ((Date.parse(a.createdAt ?? '') || 0) - (Date.parse(b.createdAt ?? '') || 0)));
      const keep = ranked[0];
      const drop = ranked.slice(1);

      const have = new Set((keep.customFields ?? []).filter((cf) => fieldValue(cf) !== null).map((cf) => cf.id));
      const copy: Array<{ id: string; field_value: string }> = [];
      for (const d of drop) for (const cf of d.customFields ?? []) {
        const v = fieldValue(cf);
        if (v !== null && !have.has(cf.id)) { copy.push({ id: cf.id, field_value: v }); have.add(cf.id); }
      }
      const owner = keep.assignedTo ? null : drop.find((d) => d.assignedTo)?.assignedTo ?? null;

      const merge: DedupeMerge = {
        contact_id: keep.contactId,
        kept: { id: keep.id, name: canonical, stage: stageName.get(keep.pipelineStageId) ?? '?', ...(tidy(keep.name) !== canonical ? { renamed_from: keep.name ?? '' } : {}) },
        deleted: drop.map((d) => ({ id: d.id, name: d.name ?? '', stage: stageName.get(d.pipelineStageId) ?? '?' })),
        fields_copied: copy.length,
      };
      if (!opts?.dryRun) {
        try {
          const body: Record<string, unknown> = {};
          if (keep.name !== canonical) body.name = canonical;
          if (copy.length) body.customFields = copy;
          if (owner) body.assignedTo = owner;
          if (Object.keys(body).length) await client.axios.put(`/opportunities/${keep.id}`, body);
          for (const d of drop) await client.axios.delete(`/opportunities/${d.id}`);
        } catch (err) {
          result.errors.push(`${keep.contactId} "${canonical}": ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
      }
      result.merges.push(merge);
    }
  }
  return result;
}
