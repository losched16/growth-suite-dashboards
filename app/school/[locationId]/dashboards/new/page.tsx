// /school/[locationId]/dashboards/new — the dashboard template gallery.
// Any school can create its own dashboards from prebuilt templates, then
// customize them in the dashboard editor. The classroom-hubs template
// generates one dashboard per classroom (enrolled students only) and is
// safe to re-run when new classrooms appear.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, LayoutDashboard, Check, Plus } from 'lucide-react';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { DASHBOARD_TEMPLATES } from '@/lib/dashboards/templates';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

type Params = Promise<{ locationId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function DashboardGalleryPage({
  params, searchParams,
}: { params: Params; searchParams: SearchParams }) {
  const { locationId } = await params;
  const sp = await searchParams;
  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();

  const { rows } = await query<{ dashboard_slug: string }>(
    `SELECT dashboard_slug FROM school_dashboards WHERE school_id = $1`,
    [school.id],
  );
  const have = new Set(rows.map((r) => r.dashboard_slug));
  const hasTemplate = (t: (typeof DASHBOARD_TEMPLATES)[number]): boolean =>
    Array.isArray(t.slugs)
      ? t.slugs.every((s) => have.has(s))
      : rows.some((r) => r.dashboard_slug.startsWith((t.slugs as { prefix: string }).prefix));

  const msg = typeof sp.msg === 'string' ? sp.msg : null;
  const err = typeof sp.err === 'string' ? sp.err : null;

  return (
    <main className="flex flex-1 flex-col items-center bg-slate-50 p-6 min-h-screen">
      <div className="w-full max-w-3xl space-y-4">
        <Link href={`/school/${locationId}`} className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700">
          <ArrowLeft className="h-3 w-3" /> Back
        </Link>
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Add a dashboard</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            {school.name} — create dashboards from prebuilt templates, then customize the columns, filters, and layout on each one.
          </p>
        </div>

        {msg ? <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{msg}</div> : null}
        {err ? <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div> : null}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {DASHBOARD_TEMPLATES.map((t) => {
            const added = hasTemplate(t);
            const rerunnable = !Array.isArray(t.slugs); // generators can re-run for new classrooms
            return (
              <div key={t.key} className="rounded-xl border border-black/10 bg-white p-4 flex flex-col">
                <div className="flex items-center gap-2">
                  <LayoutDashboard className="h-4 w-4 text-emerald-700" />
                  <h2 className="text-sm font-semibold text-slate-900">{t.title}</h2>
                </div>
                <p className="mt-1.5 flex-1 text-xs text-slate-600">{t.description}</p>
                <form action={`/api/school/${locationId}/dashboards/from-template`} method="POST" className="mt-3">
                  <input type="hidden" name="template" value={t.key} />
                  {added && !rerunnable ? (
                    <span className="inline-flex items-center gap-1.5 rounded-md bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-800">
                      <Check className="h-3.5 w-3.5" /> Added
                    </span>
                  ) : (
                    <button type="submit" className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700">
                      <Plus className="h-3.5 w-3.5" /> {added ? 'Re-run (adds new classrooms)' : 'Add dashboard'}
                    </button>
                  )}
                </form>
              </div>
            );
          })}
        </div>

        <p className="text-[11px] text-slate-400">
          Adding a template never overwrites an existing dashboard — it only creates what&rsquo;s missing. Edit any dashboard afterwards via its &ldquo;Edit layout&rdquo; link.
        </p>
      </div>
    </main>
  );
}
