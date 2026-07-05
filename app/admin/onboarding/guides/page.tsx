// /admin/onboarding/guides — operator wires each onboarding task to its help
// content (Freshdesk article URL + optional label + short video). One form,
// grouped by phase. Content lives in Freshdesk; this only stores the links, so
// there's no duplication and your team edits it here without a deploy.
// Operator-only (proxy-gated /admin/*).

import Link from 'next/link';
import { loadGuides } from '@/lib/onboarding/guides';
import {
  ONBOARDING_CHECKLIST, PHASE_ORDER, PHASE_LABELS, type Phase,
} from '@/lib/onboarding/checklist';

export const dynamic = 'force-dynamic';

export default async function GuidesEditorPage({
  searchParams,
}: { searchParams: Promise<{ msg?: string }> }) {
  const sp = await searchParams;
  const guides = await loadGuides();

  return (
    <main className="min-h-screen bg-slate-50 p-6">
      <div className="mx-auto w-full max-w-3xl space-y-5">
        <Link href="/admin/onboarding" className="text-xs text-slate-500 hover:text-slate-700">← Onboarding board</Link>
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Onboarding guides</h1>
          <p className="text-sm text-slate-500">
            Link each step to its help article. Paste a Freshdesk article URL (and optionally a short
            video) — the school sees these on their checklist. The article content stays in Freshdesk;
            this just points to it.
          </p>
        </div>

        {sp.msg ? <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{sp.msg}</div> : null}

        <form action="/api/admin/onboarding/guides/save" method="POST" className="space-y-5">
          {PHASE_ORDER.map((phase) => {
            const tasks = ONBOARDING_CHECKLIST.filter((t) => t.phase === phase);
            if (!tasks.length) return null;
            return (
              <section key={phase} className="rounded-lg border border-slate-200 bg-white overflow-hidden">
                <div className="border-b border-slate-100 bg-slate-50 px-4 py-2 text-sm font-semibold text-slate-900">
                  {PHASE_LABELS[phase as Phase]}
                </div>
                <div className="divide-y divide-slate-100">
                  {tasks.map((t) => {
                    const g = guides.get(t.key);
                    return (
                      <div key={t.key} className="px-4 py-3">
                        <div className="text-sm font-medium text-slate-900">{t.title}</div>
                        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[2fr_1fr]">
                          <Input name={`guide_url__${t.key}`} placeholder="Freshdesk article URL" defaultValue={g?.guide_url ?? ''} mono />
                          <Input name={`guide_label__${t.key}`} placeholder="Link label (optional)" defaultValue={g?.guide_label ?? ''} />
                          <Input name={`video_url__${t.key}`} placeholder="Video URL — Loom / YouTube (optional)" defaultValue={g?.video_url ?? ''} mono />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}

          <div className="sticky bottom-4">
            <button type="submit" className="rounded-md bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow hover:bg-blue-700">
              Save all guides
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}

function Input({ name, placeholder, defaultValue, mono }: { name: string; placeholder: string; defaultValue: string; mono?: boolean }) {
  return (
    <input
      type="text" name={name} placeholder={placeholder} defaultValue={defaultValue}
      className={`block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none ${mono ? 'font-mono text-[12px]' : ''}`}
    />
  );
}
