// /school/[locationId]/documents — standalone view of the "Important
// documents" manager. The SAME section is mounted on the Portal Forms
// page (/school/[locationId]/forms), which is the primary home — one
// office spot for everything that reaches the parent portal.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { SharedDocsSection } from './SharedDocsSection';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type Params = Promise<{ locationId: string }>;

export default async function SharedDocumentsPage({ params }: { params: Params }) {
  const { locationId } = await params;
  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-4 sm:py-6 space-y-4">
        <Link href={`/school/${locationId}/forms?chrome=none`}
          className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700">
          <ArrowLeft className="h-3 w-3" /> Portal Forms
        </Link>
        <SharedDocsSection schoolId={school.id} />
      </div>
    </main>
  );
}
