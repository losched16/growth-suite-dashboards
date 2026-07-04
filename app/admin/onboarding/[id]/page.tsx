// /admin/onboarding/[id] — ops detail for one school onboarding. Shows the
// shareable link, editable meta, the full checklist, submitted docs to
// review/download, submitted intake values, and the "push intake to GHL"
// action. Operator-only (proxy-gated /admin/*).

import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { query } from '@/lib/db';
import { mintOnboardingToken } from '@/lib/onboarding/token';
import { computeOnboarding } from '@/lib/onboarding/status';
import {
  CHECKLIST_BY_KEY, PHASE_ORDER, PHASE_LABELS,
  type Phase, type IntakeTask,
} from '@/lib/onboarding/checklist';

export const dynamic = 'force-dynamic';

type Params = Promise<{ id: string }>;
type SearchParams = Promise<{ msg?: string; err?: string }>;

interface Meta {
  id: string;
  school_name: string;
  contact_email: string;
  contact_name: string | null;
  ghl_location_id: string | null;
  school_id: string | null;
  target_launch_date: string | null;
  assigned_ops_email: string | null;
  notes: string | null;
  archived_at: string | null;
}

export default async function OnboardingDetailPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { id } = await params;
  const sp = await searchParams;

  const { rows: metaRows } = await query<Meta>(
    `SELECT id, school_name, contact_email, contact_name, ghl_location_id, school_id,
            to_char(target_launch_date, 'YYYY-MM-DD') AS target_launch_date,
            assigned_ops_email, notes,
            to_char(archived_at, 'YYYY-MM-DD"T"HH24:MI:SSZ') AS archived_at
       FROM school_onboarding WHERE id = $1`,
    [id],
  );
  const meta = metaRows[0];
  if (!meta) notFound();

  const snap = await computeOnboarding(id);
  if (!snap) notFound();

  const { rows: stateRows } = await query<{ task_key: string; payload: { values?: string[] }; applied_to_ghl_at: string | null }>(
    `SELECT task_key, payload, applied_to_ghl_at FROM onboarding_task_state WHERE onboarding_id = $1`,
    [id],
  );
  const stateByKey = new Map(stateRows.map((r) => [r.task_key, r]));

  const { rows: docRows } = await query<{ id: string; task_key: string; original_filename: string; status: string; size_bytes: number }>(
    `SELECT id, task_key, original_filename, status, size_bytes FROM onboarding_documents
      WHERE onboarding_id = $1 ORDER BY uploaded_at DESC`,
    [id],
  );
  const docsByKey = new Map<string, typeof docRows>();
  for (const d of docRows) {
    const arr = docsByKey.get(d.task_key) ?? [];
    arr.push(d);
    docsByKey.set(d.task_key, arr);
  }

  // Shareable link.
  const h = await headers();
  const base = `${h.get('x-forwarded-proto') ?? 'https'}://${h.get('host')}`;
  const link = `${base}/onboarding/${mintOnboardingToken(id)}`;

  const hasUnappliedIntake = [...stateByKey.entries()].some(
    ([k, s]) => CHECKLIST_BY_KEY[k]?.type === 'intake' && (s.payload?.values?.length ?? 0) > 0 && !s.applied_to_ghl_at,
  );

  return (
    <main className="min-h-screen bg-slate-50 p-6">
      <div className="mx-auto w-full max-w-3xl space-y-5">
        <Link href="/admin/onboarding" className="text-xs text-slate-500 hover:text-slate-700">← All onboardings</Link>
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="text-2xl font-semibold text-slate-900">{meta.school_name}</h1>
          <span className="text-sm text-slate-500 tabular-nums">{snap.percentComplete}% · {snap.counts.done}/{snap.counts.total}</span>
        </div>

        {sp.msg ? <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{sp.msg}</div> : null}
        {sp.err ? <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{sp.err}</div> : null}

        {/* Shareable link */}
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-900">Onboarding link for the school</h2>
          <p className="mt-0.5 text-[11px] text-slate-500">Send this to {meta.contact_email}. No login needed; valid 30 days.</p>
          <input readOnly value={link} className="mt-2 w-full rounded-md border border-slate-300 bg-slate-50 px-3 py-1.5 font-mono text-[11px] text-slate-700" />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <form action={`/api/admin/onboarding/${id}/send-link`} method="POST">
              <button type="submit" className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700">
                Email the link to {meta.contact_email}
              </button>
            </form>
            <form action={`/api/admin/onboarding/${id}/send-reminder`} method="POST">
              <button type="submit" className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">
                Send reminder now
              </button>
            </form>
          </div>
        </section>

        {/* Meta / linking */}
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">Details</h2>
          <form action={`/api/admin/onboarding/${id}/update`} method="POST" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <input type="hidden" name="op" value="meta" />
            <M label="Linked school_id (once provisioned)" name="school_id" defaultValue={meta.school_id ?? ''} placeholder="uuid" />
            <M label="GHL location ID" name="ghl_location_id" defaultValue={meta.ghl_location_id ?? ''} />
            <M label="Target launch date" name="target_launch_date" type="date" defaultValue={meta.target_launch_date ?? ''} />
            <M label="Assigned to (ops email)" name="assigned_ops_email" defaultValue={meta.assigned_ops_email ?? ''} />
            <label className="block sm:col-span-2">
              <span className="text-[11px] font-medium text-slate-600">Notes</span>
              <textarea name="notes" rows={2} defaultValue={meta.notes ?? ''} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none" />
            </label>
            <div className="sm:col-span-2">
              <button type="submit" className="rounded-md bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-900">Save details</button>
            </div>
          </form>
        </section>

        {/* Apply intake to GHL */}
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Push intake vocabularies to GHL</h2>
              <p className="mt-0.5 text-[11px] text-slate-500">
                Writes the submitted grade levels / programs / schedules / classrooms onto the sub-account’s
                custom-field picklists. Requires a linked school. Do this <strong>before</strong> importing the roster.
              </p>
            </div>
            <form action={`/api/admin/onboarding/${id}/apply-intake`} method="POST">
              <button
                type="submit"
                disabled={!meta.school_id}
                className="whitespace-nowrap rounded-md bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-40"
                title={meta.school_id ? '' : 'Link a school_id first'}
              >
                Apply to GHL
              </button>
            </form>
          </div>
          {hasUnappliedIntake ? <p className="mt-2 text-[11px] text-amber-700">Submitted intake values are waiting to be applied.</p> : null}
        </section>

        {/* Checklist */}
        {PHASE_ORDER.map((phase) => {
          const tasks = snap.tasks.filter((t) => t.phase === phase);
          if (!tasks.length) return null;
          return (
            <section key={phase}>
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">{PHASE_LABELS[phase as Phase]}</h2>
              <div className="space-y-2">
                {tasks.map((t) => {
                  const def = CHECKLIST_BY_KEY[t.key];
                  const st = stateByKey.get(t.key);
                  const docs = docsByKey.get(t.key) ?? [];
                  return (
                    <div key={t.key} className="rounded-lg border border-slate-200 bg-white p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-slate-900">{t.title}</span>
                        <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{t.status.replace('_', ' ')}</span>
                      </div>

                      {/* intake submitted values */}
                      {def?.type === 'intake' && (st?.payload?.values?.length ?? 0) > 0 ? (
                        <p className="mt-1 text-[11px] text-slate-600">
                          {(st!.payload.values ?? []).join(' · ')}
                          {st?.applied_to_ghl_at ? <span className="ml-1 text-emerald-700">· applied ✓</span> : <span className="ml-1 text-amber-700">· not applied</span>}
                          <span className="ml-1 text-slate-400">→ GHL field “{(def as IntakeTask).intake.fieldLabel}”</span>
                        </p>
                      ) : null}

                      {/* submitted docs to review */}
                      {def?.type === 'document' && docs.length ? (
                        <ul className="mt-2 space-y-1">
                          {docs.map((d) => (
                            <li key={d.id} className="flex items-center justify-between gap-2 text-[11px]">
                              <a href={`/api/admin/onboarding/doc/${d.id}`} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline">
                                📎 {d.original_filename}
                              </a>
                              <span className="flex items-center gap-1">
                                <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${d.status === 'accepted' ? 'bg-emerald-100 text-emerald-800' : d.status === 'rejected' ? 'bg-rose-100 text-rose-800' : 'bg-slate-100 text-slate-600'}`}>{d.status}</span>
                                <DocAction id={id} docId={d.id} action="accept" />
                                <DocAction id={id} docId={d.id} action="reject" />
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : null}

                      {/* ops-owned manual sign-off */}
                      {def?.type === 'manual' && def.owner === 'ops' ? (
                        <form action={`/api/admin/onboarding/${id}/update`} method="POST" className="mt-2">
                          <input type="hidden" name="op" value="ops_task" />
                          <input type="hidden" name="task_key" value={t.key} />
                          <input type="hidden" name="done" value={t.status === 'done' ? '0' : '1'} />
                          <button type="submit" className={`rounded-md px-2.5 py-1 text-[11px] font-semibold ${t.status === 'done' ? 'border border-slate-300 bg-white text-slate-600' : 'bg-emerald-600 text-white hover:bg-emerald-700'}`}>
                            {t.status === 'done' ? 'Undo sign-off' : 'Sign off'}
                          </button>
                        </form>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}

        {/* Archive / restore */}
        <form action={`/api/admin/onboarding/${id}/archive`} method="POST" className="pt-2">
          <input type="hidden" name="archive" value={meta.archived_at ? '0' : '1'} />
          <button type="submit" className="text-[11px] text-slate-400 hover:text-slate-700 hover:underline">
            {meta.archived_at ? 'Restore this onboarding' : 'Archive this onboarding'}
          </button>
        </form>
      </div>
    </main>
  );
}

function M({ label, name, defaultValue, type = 'text', placeholder }: { label: string; name: string; defaultValue?: string; type?: string; placeholder?: string }) {
  return (
    <label className="block">
      <span className="text-[11px] font-medium text-slate-600">{label}</span>
      <input type={type} name={name} defaultValue={defaultValue} placeholder={placeholder}
        className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none" />
    </label>
  );
}

function DocAction({ id, docId, action }: { id: string; docId: string; action: 'accept' | 'reject' }) {
  return (
    <form action={`/api/admin/onboarding/${id}/review-doc`} method="POST" className="inline">
      <input type="hidden" name="doc_id" value={docId} />
      <input type="hidden" name="action" value={action} />
      <button type="submit" className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${action === 'accept' ? 'text-emerald-700 hover:bg-emerald-50' : 'text-rose-700 hover:bg-rose-50'}`}>
        {action}
      </button>
    </form>
  );
}
