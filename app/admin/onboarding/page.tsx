// /admin/onboarding — ops board: every school onboarding, with live progress,
// current stage, pending doc reviews, and a create form. Operator-only (gated
// by the /admin/* operator-password proxy). The "what's done vs missing" view.

import Link from 'next/link';
import { query } from '@/lib/db';
import { computeOnboarding } from '@/lib/onboarding/status';
import { PHASE_LABELS, type Phase } from '@/lib/onboarding/checklist';

export const dynamic = 'force-dynamic';

interface Row {
  id: string;
  school_name: string;
  contact_email: string;
  school_id: string | null;
  created_at: Date;
}

export default async function OnboardingBoardPage({
  searchParams,
}: { searchParams: Promise<{ msg?: string; err?: string; archived?: string }> }) {
  const sp = await searchParams;
  const showArchived = sp.archived === '1';
  const { rows } = await query<Row>(
    `SELECT id, school_name, contact_email, school_id, created_at
       FROM school_onboarding
      WHERE archived_at IS ${showArchived ? 'NOT NULL' : 'NULL'}
      ORDER BY created_at DESC`,
  );

  // Compute live status for each (fine at current scale; if this grows,
  // persist percent_complete/stage via the writeback cron and read that).
  const withStatus = await Promise.all(rows.map(async (r) => {
    const snap = await computeOnboarding(r.id);
    const pendingDocs = await query<{ n: number }>(
      `SELECT COUNT(*)::int n FROM onboarding_documents WHERE onboarding_id = $1 AND status = 'uploaded'`,
      [r.id],
    );
    return { ...r, snap, pendingDocs: pendingDocs.rows[0]?.n ?? 0 };
  }));

  return (
    <main className="min-h-screen bg-slate-50 p-6">
      <div className="mx-auto w-full max-w-5xl space-y-5">
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">School onboarding{showArchived ? ' — archived' : ''}</h1>
            <p className="text-sm text-slate-500">Track what each school has done, submitted, or still needs.</p>
          </div>
          <Link href={showArchived ? '/admin/onboarding' : '/admin/onboarding?archived=1'} className="whitespace-nowrap text-xs text-slate-500 hover:text-slate-700 hover:underline">
            {showArchived ? '← Active' : 'Show archived'}
          </Link>
        </div>

        {sp.msg ? <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{sp.msg}</div> : null}
        {sp.err ? <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{sp.err}</div> : null}

        {/* Create */}
        <details className="rounded-lg border-2 border-blue-200 bg-blue-50/30">
          <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold text-blue-900">+ Start a new school onboarding</summary>
          <form action="/api/admin/onboarding/create" method="POST" className="space-y-3 border-t border-blue-100 bg-white px-4 py-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="School name" name="school_name" required />
              <Field label="Primary contact email" name="contact_email" type="email" required />
              <Field label="Contact name" name="contact_name" />
              <Field label="GHL location ID (optional)" name="ghl_location_id" />
            </div>
            <button type="submit" className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
              Create &amp; get link
            </button>
          </form>
        </details>

        {/* Board */}
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-left text-[10px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">School</th>
                <th className="px-4 py-2 font-medium">Stage</th>
                <th className="px-4 py-2 font-medium">Progress</th>
                <th className="px-4 py-2 font-medium text-center">Docs to review</th>
                <th className="px-4 py-2 font-medium text-center">Tenant</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {withStatus.length === 0 ? (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-sm italic text-slate-400">No onboardings yet. Start one above.</td></tr>
              ) : withStatus.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5">
                    <Link href={`/admin/onboarding/${r.id}`} className="font-medium text-blue-700 hover:underline">{r.school_name}</Link>
                    <div className="text-[11px] text-slate-500">{r.contact_email}</div>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-700">
                    {r.snap ? (r.snap.stage === 'live' ? 'Live' : PHASE_LABELS[r.snap.stage as Phase] ?? r.snap.stage) : '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    {r.snap ? (
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-slate-200">
                          <div className="h-full rounded-full bg-emerald-500" style={{ width: `${r.snap.percentComplete}%` }} />
                        </div>
                        <span className="text-[11px] tabular-nums text-slate-600">{r.snap.counts.done}/{r.snap.counts.total}</span>
                      </div>
                    ) : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-center">
                    {r.pendingDocs > 0
                      ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-800">{r.pendingDocs}</span>
                      : <span className="text-slate-300">0</span>}
                  </td>
                  <td className="px-4 py-2.5 text-center">
                    {r.school_id
                      ? <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-emerald-800">Linked</span>
                      : <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-slate-500">Lead</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}

function Field({ label, name, type = 'text', required }: { label: string; name: string; type?: string; required?: boolean }) {
  return (
    <label className="block">
      <span className="text-[11px] font-medium text-slate-600">{label} {required ? <span className="text-rose-600">*</span> : null}</span>
      <input type={type} name={name} required={required}
        className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none" />
    </label>
  );
}
