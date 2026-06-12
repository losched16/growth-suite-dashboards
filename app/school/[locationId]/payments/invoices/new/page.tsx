// /school/[locationId]/payments/invoices/new — school-scoped invoice
// creator. Mirrors /admin/[schoolId]/payments/invoices/new but its
// back / cancel links return to the Payments hub Invoices tab so the
// operator never escapes the DGM iframe.
//
// Form POSTs to /api/admin/schools/{schoolId}/payments/invoices (same
// API as the /admin route) and passes a hidden `return_to` field so
// the API redirects back to THIS page after success/failure.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { query } from '@/lib/db';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { LineItemsEditor } from '@/app/admin/[schoolId]/payments/invoices/new/LineItemsEditor';
import { RecipientPicker } from '@/app/admin/[schoolId]/payments/invoices/new/RecipientPicker';
import { loadInvoiceCatalog } from '@/lib/billing/invoice-catalog';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type Params = Promise<{ locationId: string }>;
type SearchParams = Promise<{ err?: string; family?: string }>;

interface FamilyOption {
  id: string;
  label: string;
}

export default async function NewInvoiceScoped({
  params, searchParams,
}: { params: Params; searchParams: SearchParams }) {
  const { locationId } = await params;
  const sp = await searchParams;

  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();
  const schoolId = school.id;

  const { rows: families } = await query<FamilyOption>(
    `SELECT f.id,
            COALESCE(NULLIF(f.display_name, ''),
                     CONCAT_WS(' ', p.first_name, p.last_name),
                     '(unnamed)') AS label
       FROM families f
       LEFT JOIN LATERAL (
         SELECT first_name, last_name FROM parents
         WHERE family_id = f.id AND is_primary = true LIMIT 1
       ) p ON true
      WHERE f.school_id = $1 AND f.status = 'active'
      ORDER BY label
      LIMIT 500`,
    [schoolId],
  );

  // Per-family students + parents for the attribution selects.
  const { rows: studentRows } = await query<{ family_id: string; id: string; name: string }>(
    `SELECT family_id, id, CONCAT_WS(' ', COALESCE(NULLIF(preferred_name, ''), first_name), last_name) AS name
       FROM students WHERE school_id = $1 AND status = 'active' ORDER BY first_name`,
    [schoolId],
  );
  const { rows: parentRows } = await query<{ family_id: string; id: string; name: string }>(
    `SELECT family_id, id, CONCAT_WS(' ', first_name, last_name) AS name
       FROM parents WHERE school_id = $1 AND status = 'active' ORDER BY is_primary DESC, first_name`,
    [schoolId],
  );
  const studentsByFamily: Record<string, Array<{ id: string; name: string }>> = {};
  for (const s of studentRows) (studentsByFamily[s.family_id] ??= []).push({ id: s.id, name: s.name });
  const parentsByFamily: Record<string, Array<{ id: string; name: string }>> = {};
  for (const p of parentRows) (parentsByFamily[p.family_id] ??= []).push({ id: p.id, name: p.name });

  let setupFeePaid = false;
  if (sp.family) {
    const { rows: fr } = await query<{ paid: boolean }>(
      `SELECT (platform_setup_fee_paid_at IS NOT NULL) AS paid
         FROM families WHERE id = $1 AND school_id = $2`,
      [sp.family, schoolId],
    );
    setupFeePaid = !!fr[0]?.paid;
  }

  const catalogItems = await loadInvoiceCatalog(schoolId);

  const dueDefault = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 14);
    return d.toISOString().slice(0, 10);
  })();

  // The list of invoices and the next-action target both live on the
  // Payments hub Invoices tab. Returning here keeps the operator inside
  // the iframe.
  const backHref = `/school/${locationId}/payments?tab=invoices`;
  const returnTo = `/school/${locationId}/payments?tab=invoices`;

  return (
    <main className="flex flex-1 flex-col items-center bg-slate-50 p-6 min-h-screen">
      <div className="w-full max-w-3xl space-y-4">
        <Link href={backHref} className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700">
          <ArrowLeft className="h-3 w-3" /> Back to Invoices
        </Link>

        <h1 className="text-2xl font-semibold text-slate-900">Create invoice</h1>
        <p className="text-xs text-slate-500">{school.name}</p>

        {sp.err ? (
          <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{sp.err}</div>
        ) : null}

        <form
          action={`/api/admin/schools/${schoolId}/payments/invoices`}
          method="POST"
          className="rounded-xl border border-slate-200 bg-white p-5 space-y-5"
        >
          {/* Tells the API to redirect back into the school iframe after
              create. The API validates the path before honoring it. */}
          <input type="hidden" name="return_to" value={returnTo} />

          <RecipientPicker
            schoolId={schoolId}
            families={families}
            defaultFamilyId={sp.family ?? ''}
            studentsByFamily={studentsByFamily}
            parentsByFamily={parentsByFamily}
          />

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="block sm:col-span-2">
              <span className="text-[11px] font-medium uppercase tracking-wide text-slate-600">Title *</span>
              <input type="text" name="title" required placeholder="e.g. August Tuition + Lunch"
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
            <input type="text" name="description"
              placeholder="Internal note about this invoice"
              className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1.5 text-sm" />
          </label>

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600 mb-1">Line items</h3>
            <LineItemsEditor catalogItems={catalogItems} />
          </div>

          <div className="rounded-md bg-slate-50 border border-slate-200 p-3 space-y-2">
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="includes_platform_setup_fee" value="1" defaultChecked={!setupFeePaid} disabled={setupFeePaid}
                className="mt-0.5 h-4 w-4 rounded border-slate-300" />
              <span>
                <strong>Include $25 family setup fee.</strong>
                <span className="ml-2 text-xs text-slate-500">
                  {setupFeePaid
                    ? '(Already collected from this family — disabled.)'
                    : 'Charged once per family at first plan setup. Goes to Growth Suite.'}
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="send_now" value="1" defaultChecked
                className="mt-0.5 h-4 w-4 rounded border-slate-300" />
              <span>
                <strong>Send to parent immediately.</strong>
                <span className="ml-2 text-xs text-slate-500">
                  If unchecked, the invoice is saved as a draft and can be sent later.
                </span>
              </span>
            </label>
          </div>

          <details className="rounded-md border border-slate-200 bg-white p-3">
            <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-600">
              Discounts
            </summary>
            <p className="mt-2 text-[11px] text-slate-500">
              Auto-apply discount policies (sibling, early-bird, FA) evaluate automatically against
              this family + the line categories above. Optionally enter a redemption code to apply
              a code-gated policy on top.
            </p>
            <label className="mt-2 block">
              <span className="text-[11px] font-medium uppercase tracking-wide text-slate-600">Redemption code (optional)</span>
              <input type="text" name="redemption_code"
                placeholder="e.g. WELCOME50"
                className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1.5 text-sm uppercase tracking-wider" />
            </label>
          </details>

          <div className="flex gap-2">
            <button type="submit"
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
              Create invoice
            </button>
            <Link href={backHref}
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">
              Cancel
            </Link>
          </div>
        </form>
      </div>
    </main>
  );
}
