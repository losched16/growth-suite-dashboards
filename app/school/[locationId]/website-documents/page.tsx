// /school/[locationId]/website-documents
//
// School UI for the dated documents on the PUBLIC marketing website: the
// monthly classroom newsletters / lesson plans and the lunch menu. What is
// published here is what the school's site lists on its Parent Resources
// page, via /api/website/documents/{locationId}. Bytes live on
// website_documents (bytea); see migration 113.
//
// Sibling of the Photo Gallery manager, and deliberately separate from
// /resources, which manages documents for the parent portal rather than the
// open web.

import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { FileText } from 'lucide-react';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { query } from '@/lib/db';
import { DocumentsManager, type AdminDoc } from './DocumentsManager';

export const dynamic = 'force-dynamic';

type Params = Promise<{ locationId: string }>;

export default async function SchoolWebsiteDocumentsPage({ params }: { params: Params }) {
  const { locationId } = await params;

  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) notFound();

  const { rows } = await query<AdminDoc>(
    `SELECT id, section, label,
            to_char(period_month, 'YYYY-MM-DD') AS period_month,
            original_filename, size_bytes, is_published
       FROM website_documents
      WHERE school_id = $1
      ORDER BY section, period_month DESC NULLS LAST, position, label`,
    [school.id],
  );

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        <header className="space-y-1">
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-emerald-600" />
            <h1 className="text-xl font-semibold text-gray-900">Newsletters &amp; Menus</h1>
          </div>
          <p className="text-sm text-gray-600">
            The monthly classroom newsletters, lesson plans, and lunch menus on
            your school&apos;s public website. Pick the month, drop this
            month&apos;s files in, and the Parent Resources page updates itself
            &mdash; no developer needed. The site always shows the newest month
            it has, so last month&apos;s set drops off on its own.
          </p>
        </header>
        <DocumentsManager locationId={locationId} initialDocs={rows} />
      </div>
    </main>
  );
}
