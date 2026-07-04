// /onboarding/[token] — the school-facing onboarding checklist. Pre-tenant
// (token-authed, no login) so a brand-new school can start before their
// workspace exists. Shows progress, groups tasks by phase, and gives the
// right control per task: submit an intake vocabulary, upload a document,
// check off a manual step, or (for derived/ops tasks) just show status.
//
// Server-rendered plain forms → the /api/onboarding/* routes (token in a
// hidden field). No client JS.

import { notFound } from 'next/navigation';
import { query } from '@/lib/db';
import { verifyOnboardingToken } from '@/lib/onboarding/token';
import { computeOnboarding, type ResolvedTask } from '@/lib/onboarding/status';
import {
  CHECKLIST_BY_KEY, PHASE_ORDER, PHASE_LABELS,
  type IntakeTask, type DocumentTask, type Phase,
} from '@/lib/onboarding/checklist';

export const dynamic = 'force-dynamic';

type Params = Promise<{ token: string }>;
type SearchParams = Promise<{ msg?: string; err?: string }>;

export default async function OnboardingPage({
  params, searchParams,
}: { params: Params; searchParams: SearchParams }) {
  const { token } = await params;
  const sp = await searchParams;

  const onboardingId = verifyOnboardingToken(token);
  if (!onboardingId) {
    return (
      <Shell>
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-6 text-center">
          <h1 className="text-lg font-semibold text-amber-900">This link has expired</h1>
          <p className="mt-1 text-sm text-amber-800">
            Ask your Growth Suite contact to send you a fresh onboarding link.
          </p>
        </div>
      </Shell>
    );
  }

  const snap = await computeOnboarding(onboardingId);
  if (!snap) notFound();

  // Location id (once provisioned) enables "do it in your dashboard" deep-links.
  const { rows: obMeta } = await query<{ ghl_location_id: string | null }>(
    `SELECT ghl_location_id FROM school_onboarding WHERE id = $1`,
    [onboardingId],
  );
  const locationId = obMeta[0]?.ghl_location_id ?? null;

  // Current intake values (to prefill) + uploaded docs (to show what's in).
  const { rows: stateRows } = await query<{ task_key: string; payload: { values?: string[] } }>(
    `SELECT task_key, payload FROM onboarding_task_state WHERE onboarding_id = $1`,
    [onboardingId],
  );
  const valuesByKey = new Map(stateRows.map((r) => [r.task_key, r.payload?.values ?? []]));

  const { rows: docRows } = await query<{ task_key: string; original_filename: string; status: string }>(
    `SELECT task_key, original_filename, status FROM onboarding_documents
      WHERE onboarding_id = $1 ORDER BY uploaded_at DESC`,
    [onboardingId],
  );
  const docsByKey = new Map<string, { name: string; status: string }[]>();
  for (const d of docRows) {
    const arr = docsByKey.get(d.task_key) ?? [];
    arr.push({ name: d.original_filename, status: d.status });
    docsByKey.set(d.task_key, arr);
  }

  return (
    <Shell>
      {/* Header + progress */}
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Growth Suite onboarding</p>
        <h1 className="mt-0.5 text-2xl font-bold text-slate-900">{snap.schoolName}</h1>
        <div className="mt-3 flex items-center gap-3">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-200">
            <div className="h-full rounded-full bg-emerald-500" style={{ width: `${snap.percentComplete}%` }} />
          </div>
          <span className="text-sm font-semibold text-slate-700 tabular-nums">
            {snap.counts.done}/{snap.counts.total} · {snap.percentComplete}%
          </span>
        </div>
      </div>

      {sp.msg ? <Toast kind="ok" text={sp.msg} /> : null}
      {sp.err ? <Toast kind="err" text={sp.err} /> : null}

      {PHASE_ORDER.map((phase) => {
        const tasks = snap.tasks.filter((t) => t.phase === phase);
        if (tasks.length === 0) return null;
        return (
          <section key={phase} className="mb-6">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
              {PHASE_LABELS[phase as Phase]}
            </h2>
            <div className="space-y-3">
              {tasks.map((t) => (
                <TaskCard
                  key={t.key}
                  task={t}
                  token={token}
                  locationId={locationId}
                  values={valuesByKey.get(t.key) ?? []}
                  docs={docsByKey.get(t.key) ?? []}
                />
              ))}
            </div>
          </section>
        );
      })}

      <p className="mt-8 text-center text-[11px] text-slate-400">
        Questions? Reply to your onboarding email and our team will help.
      </p>
    </Shell>
  );
}

function TaskCard({
  task, token, locationId, values, docs,
}: {
  task: ResolvedTask;
  token: string;
  locationId: string | null;
  values: string[];
  docs: { name: string; status: string }[];
}) {
  const def = CHECKLIST_BY_KEY[task.key];
  const blockedTitles = task.status === 'blocked'
    ? task.blockedBy.map((k) => CHECKLIST_BY_KEY[k]?.title ?? k)
    : [];
  const cta = def?.ctaHref && locationId && task.status !== 'done' && task.status !== 'blocked'
    ? def.ctaHref(locationId)
    : null;

  return (
    <div className={`rounded-lg border bg-white p-4 ${task.status === 'done' ? 'border-emerald-200' : 'border-slate-200'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <StatusDot status={task.status} />
            <h3 className="text-sm font-semibold text-slate-900">{task.title}</h3>
            {task.owner === 'ops' ? (
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-slate-500">Growth Suite</span>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-slate-500">{task.instructions}</p>
        </div>
        <StatusBadge status={task.status} />
      </div>

      {task.status === 'blocked' ? (
        <p className="mt-2 text-[11px] text-slate-500 italic">
          Complete first: {blockedTitles.join(', ')}.
        </p>
      ) : null}

      {/* Per-type control (only for school-owned actionable tasks) */}
      {def?.type === 'intake' && task.status !== 'blocked' ? (
        <IntakeForm task={def} token={token} values={values} status={task.status} />
      ) : null}

      {def?.type === 'document' && task.status !== 'blocked' ? (
        <DocumentForm task={def} token={token} docs={docs} />
      ) : null}

      {def?.type === 'manual' && def.owner === 'school' && task.status !== 'blocked' ? (
        <ManualForm taskKey={task.key} token={token} done={task.status === 'done'} />
      ) : null}

      {cta ? (
        <a
          href={cta}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 hover:underline"
        >
          Do it in your dashboard →
        </a>
      ) : null}
    </div>
  );
}

function IntakeForm({
  task, token, values, status,
}: { task: IntakeTask; token: string; values: string[]; status: string }) {
  return (
    <form action="/api/onboarding/submit-intake" method="POST" className="mt-3 border-t border-slate-100 pt-3">
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="task_key" value={task.key} />
      <label className="block text-[11px] font-medium text-slate-600">One per line</label>
      <textarea
        name="values"
        rows={Math.max(3, values.length + 1)}
        defaultValue={values.join('\n')}
        placeholder={task.intake.examples.join('\n')}
        className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-200"
      />
      <div className="mt-2 flex items-center gap-2">
        <button type="submit" className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700">
          {values.length ? 'Update' : 'Submit'}
        </button>
        {status === 'in_progress' ? <span className="text-[11px] text-amber-700">Submitted — we’ll apply it to your account.</span> : null}
        {status === 'done' ? <span className="text-[11px] text-emerald-700">Applied to your account ✓</span> : null}
      </div>
    </form>
  );
}

function DocumentForm({
  task, token, docs,
}: { task: DocumentTask; token: string; docs: { name: string; status: string }[] }) {
  return (
    <form action="/api/onboarding/upload-doc" method="POST" encType="multipart/form-data" className="mt-3 border-t border-slate-100 pt-3">
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="task_key" value={task.key} />
      {docs.length ? (
        <ul className="mb-2 space-y-0.5">
          {docs.map((d, i) => (
            <li key={i} className="text-[11px] text-slate-600">
              📎 {d.name} <span className="text-slate-400">· {d.status}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-center gap-2">
        <input type="file" name="file" accept={task.accept.join(',')} className="text-xs" />
        <button type="submit" className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700">
          Upload
        </button>
      </div>
    </form>
  );
}

function ManualForm({ taskKey, token, done }: { taskKey: string; token: string; done: boolean }) {
  return (
    <form action="/api/onboarding/toggle-manual" method="POST" className="mt-3 border-t border-slate-100 pt-3">
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="task_key" value={taskKey} />
      <input type="hidden" name="done" value={done ? '0' : '1'} />
      <button
        type="submit"
        className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
          done ? 'border border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
               : 'bg-emerald-600 text-white hover:bg-emerald-700'
        }`}
      >
        {done ? 'Undo' : 'Mark done'}
      </button>
    </form>
  );
}

// ── presentational bits ──
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8">
      <div className="mx-auto w-full max-w-2xl">{children}</div>
    </main>
  );
}

function Toast({ kind, text }: { kind: 'ok' | 'err'; text: string }) {
  const cls = kind === 'ok'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
    : 'border-red-200 bg-red-50 text-red-800';
  return <div className={`mb-4 rounded border px-3 py-2 text-sm ${cls}`}>{text}</div>;
}

function StatusDot({ status }: { status: ResolvedTask['status'] }) {
  const color = status === 'done' ? 'bg-emerald-500'
    : status === 'in_progress' ? 'bg-amber-400'
    : status === 'blocked' ? 'bg-slate-300'
    : 'bg-slate-300';
  return <span className={`inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full ${color}`} />;
}

function StatusBadge({ status }: { status: ResolvedTask['status'] }) {
  const map = {
    done: { cls: 'bg-emerald-100 text-emerald-800', label: 'Done' },
    in_progress: { cls: 'bg-amber-100 text-amber-800', label: 'In review' },
    not_started: { cls: 'bg-slate-100 text-slate-600', label: 'To do' },
    blocked: { cls: 'bg-slate-100 text-slate-400', label: 'Locked' },
  }[status];
  return (
    <span className={`flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${map.cls}`}>
      {map.label}
    </span>
  );
}
