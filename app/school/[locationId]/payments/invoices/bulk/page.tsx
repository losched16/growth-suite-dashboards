// /school/[locationId]/payments/invoices/bulk — bill many families the
// same invoice at once (field trip fee, materials fee, fundraiser…).
// Pick an audience (everyone / a program / a homeroom), compose line
// items, choose draft-or-send. One invoice per family.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Users } from 'lucide-react';
import { query } from '@/lib/db';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { LineItemsEditor } from '@/app/admin/[schoolId]/payments/invoices/new/LineItemsEditor';
import { loadInvoiceCatalog } from '@/lib/billing/invoice-catalog';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type Params = Promise<{ locationId: string }>;
type SearchParams = Promise<{ err?: string }>;

export default async function BulkInvoicePage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { locationId } = await params;
  const sp = await searchParams;
  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();
  const schoolId = school.id;

  // Audience facets with live family counts so the CFO sees scope
  // before sending.
  const { rows: programs } = await query<{ v: string; families: number; students: number }>(
    `SELECT s.metadata->>'program' v, COUNT(DISTINCT s.family_id)::int families, COUNT(*)::int students
       FROM students s JOIN families f ON f.id = s.family_id
      WHERE s.school_id = $1 AND s.status = 'active' AND f.status = 'active' AND s.metadata->>'program' IS NOT NULL
      GROUP BY 1 ORDER BY 1`,
    [schoolId],
  );
  const { rows: homerooms } = await query<{ v: string; families: number; students: number }>(
    `SELECT s.metadata->>'homeroom' v, COUNT(DISTINCT s.family_id)::int families, COUNT(*)::int students
       FROM students s JOIN families f ON f.id = s.family_id
      WHERE s.school_id = $1 AND s.status = 'active' AND f.status = 'active' AND s.metadata->>'homeroom' IS NOT NULL
      GROUP BY 1 ORDER BY 1`,
    [schoolId],
  );
  const { rows: allCount } = await query<{ families: number; students: number }>(
    `SELECT COUNT(DISTINCT s.family_id)::int families, COUNT(*)::int students
       FROM students s JOIN families f ON f.id = s.family_id
      WHERE s.school_id = $1 AND s.status = 'active' AND f.status = 'active'`,
    [schoolId],
  );

  const catalogItems = await loadInvoiceCatalog(schoolId);
  const dueDefault = (() => { const d = new Date(); d.setDate(d.getDate() + 14); return d.toISOString().slice(0, 10); })();
  const returnTo = `/school/${locationId}/payments?tab=invoices`;

  return (
    <main className="flex flex-1 flex-col items-center bg-slate-50 p-6 min-h-screen">
      <div className="w-full max-w-3xl space-y-4">
        <Link href={returnTo} className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700">
          <ArrowLeft className="h-3 w-3" /> Back to Invoices
        </Link>

        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-blue-600" />
          <h1 className="text-2xl font-semibold text-slate-900">Bulk invoice</h1>
        </div>
        <p className="text-sm text-slate-600 max-w-2xl">
          Send the same invoice to many families at once — a field trip fee, materials fee,
          yearbook charge. One invoice per family, even when multiple students match.
        </p>

        {sp.err ? (
          <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{sp.err}</div>
        ) : null}

        <form
          action={`/api/admin/schools/${schoolId}/payments/invoices/bulk`}
          method="POST"
          className="rounded-xl border border-slate-200 bg-white p-5 space-y-5"
        >
          <input type="hidden" name="return_to" value={returnTo} />

          {/* Audience */}
          <fieldset className="rounded-md border border-blue-200 bg-blue-50/30 p-3 space-y-2">
            <legend className="px-1 text-sm font-semibold text-blue-900">Who gets this invoice?</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="audience_type" value="all" defaultChecked />
              <span>All families <span className="text-xs text-slate-500">({allCount[0]?.families ?? 0} families · {allCount[0]?.students ?? 0} students)</span></span>
            </label>
            <div className="flex items-center gap-2 text-sm">
              <input type="radio" name="audience_type" value="program" id="aud-program" />
              <label htmlFor="aud-program">By program:</label>
              <select name="audience_value" className="rounded border border-slate-300 px-2 py-1 text-sm" defaultValue="">
                <option value="">— pick —</option>
                {programs.map((p) => (
                  <option key={`p-${p.v}`} value={p.v}>{p.v} ({p.families} families · {p.students} students)</option>
                ))}
                {homerooms.map((h) => (
                  <option key={`h-${h.v}`} value={h.v}>{h.v} ({h.families} families · {h.students} students)</option>
                ))}
              </select>
            </div>
            <p className="text-[11px] text-slate-500">
              The dropdown lists programs first, then homerooms. Pick &ldquo;By program&rdquo; for either —
              the value decides the audience. (Homeroom values match against homerooms automatically.)
            </p>
          </fieldset>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="block sm:col-span-2">
              <span className="text-[11px] font-medium uppercase tracking-wide text-slate-600">Title *</span>
              <input type="text" name="title" required placeholder="e.g. Spring Field Trip Fee"
                className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1.5 text-sm" />
            </label>
            <label className="block">
              <span className="text-[11px] font-medium uppercase tracking-wide text-slate-600">Due date *</span>
              <input type="date" name="due_date" required defaultValue={dueDefault}
                className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1.5 text-sm" />
            </label>
          </div>

          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wide text-slate-600">Description (optional)</span>
            <input type="text" name="description" placeholder="Shown to parents on the invoice"
              className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1.5 text-sm" />
          </label>

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600 mb-1">Line items (same for every family)</h3>
            <LineItemsEditor catalogItems={catalogItems} />
          </div>

          <div className="rounded-md bg-slate-50 border border-slate-200 p-3 space-y-2">
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="send_now" value="1" className="mt-0.5 h-4 w-4 rounded border-slate-300" />
              <span>
                <strong>Send immediately.</strong>
                <span className="ml-2 text-xs text-slate-500">
                  Unchecked (recommended first time): creates DRAFTS you can review in the Invoices tab before sending.
                </span>
              </span>
            </label>
            <p className="text-[11px] text-slate-500">
              Note: automatic discount policies (sibling, early-bird) are not applied to bulk invoices —
              bulk is for flat fees. Tuition belongs in tuition plans.
            </p>
          </div>

          <div className="flex gap-2">
            <button type="submit" className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
              Create bulk invoices
            </button>
            <Link href={returnTo} className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">
              Cancel
            </Link>
          </div>
        </form>
      </div>
    </main>
  );
}
