// /school/[locationId]/forms — dedicated "Parent Portal → Forms" page.
// Reuses the same forms-management UI that also appears as the Payments
// hub's Forms tab, but surfaces it under its own Parent Portal nav section
// (forms are portal management, not billing).

import { notFound } from 'next/navigation';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { PaymentsHubForms } from '../payments/tabs/Forms';

export const dynamic = 'force-dynamic';

type Params = Promise<{ locationId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function SchoolFormsPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { locationId } = await params;
  const sp = await searchParams;
  const msg = typeof sp.msg === 'string' ? sp.msg : null;
  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();

  return (
    <main className="flex flex-1 flex-col bg-slate-50 p-6 min-h-screen">
      <div className="w-full max-w-5xl mx-auto">
        {msg ? (
          <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{msg}</div>
        ) : null}
        <PaymentsHubForms schoolId={school.id} locationId={locationId} />
      </div>
    </main>
  );
}
