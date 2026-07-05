// Push a school's submitted intake vocabularies INTO their GHL sub-account.
//
// This is the payoff of collecting grade levels / programs / schedules /
// classrooms via structured intake instead of instructions: one submission
// becomes the picklist options on the matching GHL custom fields (all student
// slots), which is the same source the roster sync, dashboards, parent portal,
// and form logic read. Collect once, push once, consistent everywhere.
//
// Field-kit ships these SINGLE_OPTIONS fields with a ['Set at intake']
// placeholder (lib/onboarding/field-kit.ts) — this replaces it.
//
// ⚠️ LIVE GHL WRITE — must be tested against a real sub-account from the
// desktop before trusting in prod (the cloud session can't call GHL). Apply
// intake BEFORE importing the roster: replacing a field's options is clean
// while no contact holds a real value yet.

import { loadGhlClient } from '@/lib/ghl/client';
import { query } from '@/lib/db';
import { ONBOARDING_CHECKLIST, type IntakeTask } from './checklist';

interface GhlCustomField {
  id: string;
  name?: string;
  dataType?: string;
  fieldKey?: string;
  options?: string[];
}

// Normalize submitted values: trim, drop blanks, de-dupe (case-insensitive,
// first spelling wins), cap length.
function cleanValues(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const v = String(raw ?? '').trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v.slice(0, 100));
    if (out.length >= 50) break;
  }
  return out;
}

// Fields named "Student N <label>" (any slot) or exactly "<label>".
function matchesLabel(fieldName: string | undefined, label: string): boolean {
  if (!fieldName) return false;
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^(Student \\d+ )?${esc}$`, 'i').test(fieldName.trim());
}

export interface ApplyResult {
  fieldLabel: string;
  values: string[];
  updatedFieldIds: string[];
  matchedCount: number;
}

// Push one vocabulary onto every matching custom field in the location.
export async function applyIntakeVocabulary(
  schoolId: string,
  fieldLabel: string,
  values: string[],
): Promise<ApplyResult> {
  const clean = cleanValues(values);
  if (clean.length === 0) {
    return { fieldLabel, values: [], updatedFieldIds: [], matchedCount: 0 };
  }

  const client = await loadGhlClient(schoolId);
  const { data } = await client.axios.get<{ customFields?: GhlCustomField[] }>(
    `/locations/${client.locationId}/customFields`,
  );
  const targets = (data.customFields ?? []).filter((f) => matchesLabel(f.name, fieldLabel));

  const updatedFieldIds: string[] = [];
  for (const f of targets) {
    // Preserve name + dataType; only swap the options. (GHL's update endpoint
    // is tolerant, but sending them avoids surprises across API versions.)
    await client.axios.put(`/locations/${client.locationId}/customFields/${f.id}`, {
      name: f.name,
      dataType: f.dataType ?? 'SINGLE_OPTIONS',
      options: clean,
    });
    updatedFieldIds.push(f.id);
  }

  return { fieldLabel, values: clean, updatedFieldIds, matchedCount: targets.length };
}

// Apply EVERY submitted intake vocabulary for an onboarding, then stamp each
// task as applied. Returns a per-vocabulary summary. Operator-triggered from
// the ops board (after reviewing the submitted values).
export async function applyAllIntake(
  onboardingId: string,
  appliedByEmail: string,
): Promise<{ applied: ApplyResult[]; skipped: string[] }> {
  const { rows: obRows } = await query<{ school_id: string | null }>(
    `SELECT school_id FROM school_onboarding WHERE id = $1`,
    [onboardingId],
  );
  const schoolId = obRows[0]?.school_id;
  if (!schoolId) {
    throw new Error('Cannot apply intake: this onboarding has no provisioned school yet.');
  }

  const intakeTasks = ONBOARDING_CHECKLIST.filter((t): t is IntakeTask => t.type === 'intake');
  const { rows: stateRows } = await query<{ task_key: string; payload: { values?: string[] } }>(
    `SELECT task_key, payload FROM onboarding_task_state
      WHERE onboarding_id = $1 AND task_key = ANY($2)`,
    [onboardingId, intakeTasks.map((t) => t.key)],
  );
  const payloadByKey = new Map(stateRows.map((r) => [r.task_key, r.payload]));

  const applied: ApplyResult[] = [];
  const skipped: string[] = [];
  for (const task of intakeTasks) {
    const values = payloadByKey.get(task.key)?.values ?? [];
    if (!values.length) { skipped.push(task.key); continue; }

    const result = await applyIntakeVocabulary(schoolId, task.intake.fieldLabel, values);
    applied.push(result);

    await query(
      `UPDATE onboarding_task_state
          SET status = 'applied', applied_to_ghl_at = now(),
              applied_by_email = $2, updated_at = now()
        WHERE onboarding_id = $1 AND task_key = $3`,
      [onboardingId, appliedByEmail, task.key],
    );
  }

  return { applied, skipped };
}
