// Mirror student data onto the student's OPPORTUNITY card.
//
// Schools want to filter their admissions pipeline by grade level, but the
// grade lives on the CONTACT (student_N_grade_level) and pipeline filters
// only see opportunity-level fields. This step copies it across on every
// sync, so a card picks up its grade within one cycle of the office
// setting it — new students included — and follows later changes (e.g.
// the yearly grade rollover). The contact stays the source of truth: we
// only ever write the opportunity, never the contact, and never clear a
// value (a blank grade on the contact leaves the card alone).
//
// Gated on schools.settings.opportunity_student_fields — a map of student
// metadata key → opportunity custom field id, e.g.
//   { "grade_level": "<opportunity field id>" }
//
// Which student does a card belong to?
//   1. a student on the card's contact whose name matches the card name
//   2. else the card is named after the CONTACT and that contact has
//      exactly one student (tour cards are created parent-named)
//   3. else a name match within the same family (blended / co-parent
//      households keep the card on one parent, the student on the other)
//   4. else leave the card alone

import { query } from '@/lib/db';
import { loadGhlClient } from '@/lib/ghl/client';
import { fetchAllOpportunities } from '@/lib/ghl/pipelines';
import { loadSchoolSettings } from '@/lib/school-settings';

export interface OpportunityStudentFieldsResult {
  ran: boolean;
  updated: number;
  unmatched: number;
  errors: number;
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

// Synced dates are ISO datetimes ("2019-04-28T00:00:00.000Z"); the card
// wants and reports a plain date. Non-dates pass through untouched.
const dateOnly = (v: string): string => (/^\d{4}-\d{2}-\d{2}T/.test(v) ? v.slice(0, 10) : v);

function nameMatches(k: StudentRow, n: string): boolean {
  if (norm(`${k.first_name ?? ''} ${k.last_name ?? ''}`) === n) return true;
  return !!k.preferred_name && norm(`${k.preferred_name} ${k.last_name ?? ''}`) === n;
}

export async function syncOpportunityStudentFields(schoolId: string): Promise<OpportunityStudentFieldsResult> {
  const result: OpportunityStudentFieldsResult = { ran: false, updated: 0, unmatched: 0, errors: 0 };
  const settings = await loadSchoolSettings(schoolId);
  const fieldMap = Object.entries(settings.opportunity_student_fields);
  if (fieldMap.length === 0) return result;
  result.ran = true;

  // Active students first so a re-enrolled student wins over a stale row.
  const { rows: students } = await query<StudentRow>(
    `SELECT s.metadata->>'ghl_contact_id' AS cid, s.family_id, s.first_name, s.last_name,
            s.preferred_name, s.metadata
       FROM students s
      WHERE s.school_id = $1 AND s.metadata->>'ghl_contact_id' IS NOT NULL
      ORDER BY (s.status = 'active') DESC`,
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
  for (const p of parents) {
    familiesOfContact.set(p.cid, (familiesOfContact.get(p.cid) ?? new Set()).add(p.family_id));
  }

  const client = await loadGhlClient(schoolId);
  const opps = await fetchAllOpportunities(client);

  for (const o of opps) {
    const n = norm(o.name);
    const own = byContact.get(o.contactId) ?? [];
    let kid = own.find((k) => nameMatches(k, n));
    if (!kid && own.length === 1 && n !== '' && norm(o.contact?.name) === n) kid = own[0];
    if (!kid) {
      const fam = [...(familiesOfContact.get(o.contactId) ?? [])].flatMap((f) => byFamily.get(f) ?? []);
      kid = fam.find((k) => nameMatches(k, n));
    }
    if (!kid) { result.unmatched++; continue; }

    const writes: Array<{ id: string; field_value: string }> = [];
    for (const [metaKey, fieldId] of fieldMap) {
      const desired = dateOnly(String(kid.metadata?.[metaKey] ?? '').trim());
      if (!desired) continue; // never clear — a blank on the contact leaves the card alone
      const cur = (o.customFields ?? []).find((f) => f.id === fieldId);
      // DATE fields come back from search as epoch ms, not a string. Compare
      // both sides as YYYY-MM-DD or every card looks "changed" every cycle.
      const current = typeof cur?.fieldValueDate === 'number'
        ? new Date(cur.fieldValueDate).toISOString().slice(0, 10)
        : dateOnly(String(cur?.fieldValueString ?? cur?.fieldValue ?? '').trim());
      if (current !== desired) writes.push({ id: fieldId, field_value: desired });
    }
    if (writes.length === 0) continue;
    try {
      await client.axios.put(`/opportunities/${o.id}`, { customFields: writes });
      result.updated++;
      await new Promise((r) => setTimeout(r, 180));
    } catch (e) {
      result.errors++;
      console.warn('[opportunity-student-fields] failed for opportunity', o.id, ':', e instanceof Error ? e.message : String(e));
    }
  }
  return result;
}
