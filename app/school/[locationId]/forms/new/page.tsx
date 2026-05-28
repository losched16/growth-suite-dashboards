// /school/[locationId]/forms/new — create a new portal form from inside
// the GHL iframe. Mirrors /admin/[schoolId]/forms/new but stays within
// the school context (school session, school-namespaced URLs).
//
// Reached from the Payments hub → Forms tab → "+ Create new form" button.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { query } from '@/lib/db';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { NewFormForm } from './NewFormForm';

export const dynamic = 'force-dynamic';

type Params = Promise<{ locationId: string }>;
type SearchParams = Promise<{ chrome?: string }>;

export default async function NewSchoolFormPage({
  params, searchParams,
}: { params: Params; searchParams: SearchParams }) {
  const { locationId } = await params;
  await searchParams; // consumed; chrome is handled by proxy
  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();

  // Pull existing slugs so the wizard can client-side validate duplicates.
  const { rows: existingSlugs } = await query<{ slug: string }>(
    `SELECT slug FROM portal_form_definitions
      WHERE school_id = $1 AND COALESCE(audience, 'parents') = 'parents'`,
    [school.id],
  );

  return (
    <main className="flex flex-1 flex-col items-center bg-zinc-50 p-6">
      <div className="w-full max-w-2xl space-y-4">
        <Link
          href={`/school/${locationId}/payments?chrome=none#forms`}
          className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-700"
        >
          <ArrowLeft className="h-3 w-3" /> Back to Payments → Forms
        </Link>
        <header>
          <h1 className="text-2xl font-semibold text-zinc-900">Create a new form</h1>
          <p className="mt-1 text-sm text-zinc-600">
            Pick a few essentials. You&rsquo;ll add the fields on the next screen.
          </p>
        </header>
        <NewFormForm
          locationId={locationId}
          existingSlugs={existingSlugs.map((s) => s.slug)}
        />
      </div>
    </main>
  );
}
