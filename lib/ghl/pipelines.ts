import type { GhlClient } from './client';

export interface PipelineStage {
  id: string;
  name: string;
  position?: number;
}

export interface Pipeline {
  id: string;
  name: string;
  stages: PipelineStage[];
}

export interface Opportunity {
  id: string;
  name?: string;
  contactId: string;
  pipelineId: string;
  pipelineStageId: string;
  status: string;
  monetaryValue?: number;
  lastStageChangeAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export async function fetchPipelines(client: GhlClient): Promise<Pipeline[]> {
  const { data } = await client.axios.get<{ pipelines?: Pipeline[] }>(
    `/opportunities/pipelines`,
    { params: { locationId: client.locationId } }
  );
  return data.pipelines ?? [];
}

export async function fetchAllOpportunities(client: GhlClient): Promise<Opportunity[]> {
  const all: Opportunity[] = [];
  let startAfter: string | undefined;
  let startAfterId: string | undefined;
  for (let i = 0; i < 100; i++) {
    const params = new URLSearchParams({ location_id: client.locationId, limit: '100' });
    if (startAfter && startAfterId) {
      params.set('startAfter', startAfter);
      params.set('startAfterId', startAfterId);
    }
    const { data } = await client.axios.get<{
      opportunities?: (Opportunity & { sort?: [string, string] })[];
    }>(`/opportunities/search?${params}`);
    const opps = data.opportunities ?? [];
    if (opps.length === 0) break;
    all.push(...opps);
    const last = opps[opps.length - 1];
    if (!last.sort || last.sort.length < 2) break;
    [startAfter, startAfterId] = last.sort;
    if (opps.length < 100) break;
  }
  return all;
}

export interface StageInfo {
  stageName: string;
  pipelineName: string;
  pipelineId: string;
  position?: number;
}

// stageId → { stageName, pipelineName, pipelineId, position }
export function buildStageLookup(pipelines: Pipeline[]): Map<string, StageInfo> {
  const m = new Map<string, StageInfo>();
  for (const p of pipelines) {
    for (const s of p.stages ?? []) {
      m.set(s.id, {
        stageName: s.name,
        pipelineName: p.name,
        pipelineId: p.id,
        position: s.position,
      });
    }
  }
  return m;
}

// Group opportunities by contactId.
export function indexOpportunitiesByContact(opps: Opportunity[]): Map<string, Opportunity[]> {
  const m = new Map<string, Opportunity[]>();
  for (const o of opps) {
    if (!o.contactId) continue;
    const list = m.get(o.contactId) ?? [];
    list.push(o);
    m.set(o.contactId, list);
  }
  return m;
}

// Pick the most-relevant opportunity for a contact: prefer 'open' status,
// else most recently changed. Returns null if list is empty.
export function pickPrimaryOpportunity(opps: Opportunity[]): Opportunity | null {
  if (opps.length === 0) return null;
  const open = opps.filter((o) => o.status === 'open');
  const pool = open.length > 0 ? open : opps;
  return [...pool].sort((a, b) => {
    const at = new Date(a.lastStageChangeAt ?? a.updatedAt ?? a.createdAt ?? 0).getTime();
    const bt = new Date(b.lastStageChangeAt ?? b.updatedAt ?? b.createdAt ?? 0).getTime();
    return bt - at;
  })[0];
}
