// Label new prospects "Pre-Enrolled".
//
// A child who has an open card in the admissions pipeline, at a stage before
// the portal gate stage (Pending), and whose enrollment status on the contact
// is still BLANK, gets student_N_enrollment_status = "Pre-Enrolled" written
// back to the contact — so a family that has just booked a tour or applied is
// no longer "no status".
//
// Safe by construction:
//   - fills BLANKS only. Enrolled / Pending / Hold / Withdrawn / anything a
//     person or workflow already set is never touched. The contact is re-read
//     right before the write, so a stale snapshot can't overwrite a fresh value.
//   - only cards still open, in a stage strictly before the gate stage, and not
//     in an excluded stage (cancelled, no-show, rescinded, declined, wait list).
//   - one student per card: the card is matched to its student by name (same
//     matching as opportunity-student-fields), and only that student's slot is
//     written. A sibling with no card of their own is left alone.
//   - capped per run, and the Pending / Enrolled workflows take over afterward
//     because those statuses overwrite this one.
//
// Gated on schools.settings.pre_enroll_prospects (default off).

import { query } from '@/lib/db';
import { loadGhlClient } from '@/lib/ghl/client';
import { fetchAllOpportunities, fetchPipelines } from '@/lib/ghl/pipelines';
import { loadSchoolSettings } from '@/lib/school-settings';

export const PRE_ENROLLED = 'Pre-Enrolled';
const MAX_WRITES_PER_RUN = 40;

export interface PreEnrollResult {
  ran: boolean;
  dry_run: boolean;
  set: number;
  already_has_status: number;
  unmatched: number;
  errors: number;
  students: string[];
}

interface StudentRow {
  cid: string;
  family_id: string;
  first_name: string | null;
  last_name: string | null;
  preferred_name: string | null;
  metadata: Record<string, unknown> | null;
}

const norm = (s: unknown): string =>
  String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

function nameMatches(k: StudentRow, n: string): boolean {
  if (norm(`${k.first_name ?? ''} ${k.last_name ?? ''}`) === n) return true;
  return !!k.preferred_name && norm(`${k.preferred_name} ${k.last_name ?? ''}`) === n;
}

export async function preEnrollProspects(
  schoolId: string,
  opts?: { dryRun?: boolean; limit?: number; force?: boolean },
): Promise<PreEnrollResult> {
  const dryRun = opts?.dryRun === true;
  const limit = Math.min(opts?.limit ?? MAX_WRITES_PER_RUN, MAX_WRITES_PER_RUN);
  const result: PreEnrollResult = { ran: false, dry_run: dryRun, set: 0, already_has_status: 0, unmatched: 0, errors: 0, students: [] };
  const settings = await loadSchoolSettings(schoolId);
  // `force` is for the manual route (dry run / capped trial) before the school switches the setting on.
  if (!settings.pre_enroll_prospects && !opts?.force) return result;
  const gateName = norm(settings.portal_gate_stage ?? 'Pending');
  const excluded = new Set(settings.pre_enroll_exclude_stages.map(norm));
  result.ran = true;

  const client = await loadGhlClient(schoolId);
  const pipelines = await fetchPipelines(client);

  // Stages strictly before the gate stage, in each pipeline that has one.
  const eligibleStage = new Set<string>();
  for (const p of pipelines) {
    const ordered = [...p.stages].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    const gateIdx = ordered.findIndex((s) => norm(s.name) === gateName);
    if (gateIdx <= 0) continue;
    for (const s of ordered.slice(0, gateIdx)) if (!excluded.has(norm(s.name))) eligibleStage.add(s.id);
  }
  if (eligibleStage.size === 0) return result;

  // The student_N_enrollment_status custom-field ids.
  const { data: cf } = await client.axios.get<{ customFields?: Array<{ id: string; fieldKey?: string }> }>(
    `/locations/${client.locationId}/customFields`,
    { params: { model: 'contact' } },
  );
  const statusFieldId = new Map<number, string>();
  for (const f of cf.customFields ?? []) {
    const m = /^(?:contact\.)?student_(\d+)_enrollment_status$/.exec(f.fieldKey ?? '');
    if (m) statusFieldId.set(Number(m[1]), f.id);
  }

  const { rows: students } = await query<StudentRow>(
    `SELECT s.metadata->>'ghl_contact_id' AS cid, s.family_id, s.first_name, s.last_name,
            s.preferred_name, s.metadata
       FROM students s
      WHERE s.school_id = $1 AND s.status = 'active' AND s.metadata->>'ghl_contact_id' IS NOT NULL`,
    [schoolId],
  );
  const { rows: parents } = await query<{ cid: string; family_id: string }>(
    `SELECT ghl_contact_id AS cid, family_id FROM parents
      WHERE school_id = $1 AND ghl_contact_id IS NOT NULL`,
    [schoolId],
  );
  const byContact = new Map<string, StudentRow[]>();
  const byFamily = new Map<string, StudentRow[]>();
  for (const s of students) {
    byContact.set(s.cid, [...(byContact.get(s.cid) ?? []), s]);
    byFamily.set(s.family_id, [...(byFamily.get(s.family_id) ?? []), s]);
  }
  const familiesOfContact = new Map<string, Set<string>>();
  for (const p of parents) familiesOfContact.set(p.cid, (familiesOfContact.get(p.cid) ?? new Set()).add(p.family_id));

  const opps = await fetchAllOpportunities(client);
  const done = new Set<string>(); // contact|slot written this run

  for (const o of opps) {
    if (result.set >= limit) break;
    if (o.status && o.status !== 'open') continue;
    if (!eligibleStage.has(o.pipelineStageId)) continue;

    const n = norm(o.name);
    const own = byContact.get(o.contactId) ?? [];
    let kid = own.find((k) => nameMatches(k, n));
    if (!kid && own.length === 1 && n !== '' && norm(o.contact?.name) === n) kid = own[0];
    if (!kid) {
      const fam = [...(familiesOfContact.get(o.contactId) ?? [])].flatMap((f) => byFamily.get(f) ?? []);
      kid = fam.find((k) => nameMatches(k, n));
    }
    if (!kid) { result.unmatched++; continue; }

    const slot = Number(kid.metadata?.ghl_slot);
    const fieldId = Number.isFinite(slot) ? statusFieldId.get(slot) : undefined;
    if (!fieldId) { result.unmatched++; continue; }
    if (String(kid.metadata?.enrollment_status ?? '').trim() !== '') { result.already_has_status++; continue; }

    const key = `${kid.cid}|${slot}`;
    if (done.has(key)) continue;
    done.add(key);

    try {
      // Re-read the contact: never overwrite a value that landed since the last sync.
      const { data } = await client.axios.get<{ contact?: { customFields?: Array<{ id: string; value?: unknown }> } }>(
        `/contacts/${kid.cid}`,
      );
      const cur = (data.contact?.customFields ?? []).find((f) => f.id === fieldId)?.value;
      if (String(cur ?? '').trim() !== '') { result.already_has_status++; continue; }
      if (!dryRun) {
        await client.axios.put(`/contacts/${kid.cid}`, { customFields: [{ id: fieldId, field_value: PRE_ENROLLED }] });
        await new Promise((r) => setTimeout(r, 250));
      }
      result.set++;
      result.students.push(`${kid.first_name ?? ''} ${kid.last_name ?? ''}`.trim());
    } catch (e) {
      result.errors++;
      console.warn('[pre-enroll-prospects] failed for contact', kid.cid, ':', e instanceof Error ? e.message : String(e));
    }
  }
  return result;
}
