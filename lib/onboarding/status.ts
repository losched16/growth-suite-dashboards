// Onboarding status engine — the shared "truth" used by the school-facing
// checklist, the ops board, and the GHL status writeback. Resolves every task
// in the registry to done / in_progress / not_started / blocked from a mix of
// live system state (derived tasks) and stored state (document/manual/intake).

import { query } from '@/lib/db';
import {
  ONBOARDING_CHECKLIST, PHASE_ORDER,
  type OnboardingTask, type TaskStatus, type Phase, type OnboardingContext,
} from './checklist';

export interface ResolvedTask {
  key: string;
  title: string;
  type: OnboardingTask['type'];
  phase: Phase;
  owner: OnboardingTask['owner'];
  instructions: string;
  status: TaskStatus;
  blockedBy: string[];
}

export interface OnboardingSnapshot {
  onboardingId: string;
  schoolId: string | null;
  schoolName: string;
  contactEmail: string;
  tasks: ResolvedTask[];
  percentComplete: number;
  stage: string;                 // coarse phase label for GHL sync / display
  counts: { done: number; total: number };
}

interface OnboardingRow {
  id: string;
  school_id: string | null;
  school_name: string;
  contact_email: string;
}

export async function computeOnboarding(onboardingId: string): Promise<OnboardingSnapshot | null> {
  const { rows: obRows } = await query<OnboardingRow>(
    `SELECT id, school_id, school_name, contact_email
       FROM school_onboarding WHERE id = $1`,
    [onboardingId],
  );
  const ob = obRows[0];
  if (!ob) return null;

  const ctx: OnboardingContext = { onboardingId, schoolId: ob.school_id };

  // Stored state for non-derived tasks, in one query each.
  const { rows: stateRows } = await query<{ task_key: string; status: string; applied_to_ghl_at: string | null; payload: unknown }>(
    `SELECT task_key, status, applied_to_ghl_at, payload
       FROM onboarding_task_state WHERE onboarding_id = $1`,
    [onboardingId],
  );
  const stateByKey = new Map(stateRows.map((r) => [r.task_key, r]));

  const { rows: docRows } = await query<{ task_key: string; status: string }>(
    `SELECT task_key, status FROM onboarding_documents WHERE onboarding_id = $1`,
    [onboardingId],
  );
  const docsByKey = new Map<string, string[]>();
  for (const d of docRows) {
    const arr = docsByKey.get(d.task_key) ?? [];
    arr.push(d.status);
    docsByKey.set(d.task_key, arr);
  }

  // ── Pass 1: raw status per task (ignoring blockedBy) ──
  const raw = new Map<string, TaskStatus>();
  for (const task of ONBOARDING_CHECKLIST) {
    raw.set(task.key, await rawStatus(task, ctx, stateByKey.get(task.key), docsByKey.get(task.key)));
  }

  // ── Pass 2: apply blockedBy — a not-done task with an unmet prereq shows
  //    as blocked (so the school sees "do X first" instead of a dead button). ──
  const tasks: ResolvedTask[] = ONBOARDING_CHECKLIST.map((task) => {
    let status = raw.get(task.key)!;
    if (status !== 'done' && task.blockedBy?.length) {
      const unmet = task.blockedBy.some((k) => raw.get(k) !== 'done');
      if (unmet) status = 'blocked';
    }
    return {
      key: task.key, title: task.title, type: task.type, phase: task.phase,
      owner: task.owner, instructions: task.instructions, status,
      blockedBy: task.blockedBy ?? [],
    };
  });

  const done = tasks.filter((t) => t.status === 'done').length;
  const total = tasks.length;
  const percentComplete = total === 0 ? 0 : Math.round((done / total) * 100);

  return {
    onboardingId, schoolId: ob.school_id, schoolName: ob.school_name,
    contactEmail: ob.contact_email, tasks, percentComplete,
    stage: deriveStage(tasks), counts: { done, total },
  };
}

async function rawStatus(
  task: OnboardingTask,
  ctx: OnboardingContext,
  state: { status: string; applied_to_ghl_at: string | null } | undefined,
  docStatuses: string[] | undefined,
): Promise<TaskStatus> {
  switch (task.type) {
    case 'derived':
      return (await task.deriveDone(ctx)) ? 'done' : 'not_started';

    case 'document': {
      if (!docStatuses || docStatuses.length === 0) return 'not_started';
      if (docStatuses.includes('accepted')) return 'done';
      if (docStatuses.includes('rejected') && !docStatuses.includes('uploaded')) return 'not_started';
      return 'in_progress'; // uploaded, awaiting review
    }

    case 'manual':
      if (!state) return 'not_started';
      return state.status === 'done' || state.status === 'approved' ? 'done' : 'not_started';

    case 'intake':
      if (!state) return 'not_started';
      if (state.applied_to_ghl_at || state.status === 'applied') return 'done';
      if (state.status === 'submitted' || state.status === 'approved') return 'in_progress';
      return 'not_started';
  }
}

// Coarse stage = the first phase (in order) that still has an incomplete task,
// or 'live' when everything's done. Used for GHL sync + a one-word status chip.
function deriveStage(tasks: ResolvedTask[]): string {
  for (const phase of PHASE_ORDER) {
    const inPhase = tasks.filter((t) => t.phase === phase);
    if (inPhase.some((t) => t.status !== 'done')) return phase;
  }
  return 'live';
}
