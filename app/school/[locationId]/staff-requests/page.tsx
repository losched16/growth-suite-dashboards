// /school/[locationId]/staff-requests
//
// Landing page for teachers: pick a form to fill out, or jump to
// "My recent requests". The 3 staff forms (audience='staff') are
// dynamically loaded so adding more is a seed change, not code.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { FileText, Inbox, Wrench, AlertCircle, Package } from 'lucide-react';
import { query } from '@/lib/db';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';

export const dynamic = 'force-dynamic';

type Params = Promise<{ locationId: string }>;

interface FormRow {
  id: string;
  slug: string;
  display_name: string;
  description: string | null;
}

const ICON_BY_SLUG: Record<string, React.ComponentType<{ className?: string }>> = {
  'staff-labor-request': Wrench,
  'staff-incident-report': AlertCircle,
  'staff-supply-request': Package,
};

export default async function StaffRequestsLanding({ params }: { params: Params }) {
  const { locationId } = await params;
  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();

  const { rows: forms } = await query<FormRow>(
    `SELECT id, slug, display_name, description
       FROM portal_form_definitions
      WHERE school_id = $1 AND audience = 'staff' AND is_active = true
      ORDER BY display_name`,
    [school.id],
  );

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="max-w-3xl mx-auto px-6 py-8">
        <div className="flex items-baseline justify-between mb-6 flex-wrap gap-2">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">Staff requests</h1>
            <p className="text-sm text-slate-500 mt-0.5">
              Submit a request, then track its status here. Lexi gets a notification on every submission.
            </p>
          </div>
          <Link
            href={`/school/${locationId}/staff-requests/mine?chrome=none`}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <Inbox className="h-4 w-4" /> My recent requests
          </Link>
        </div>

        {forms.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-500 italic">
            No staff request forms are configured for this school yet.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {forms.map((f) => {
              const Icon = ICON_BY_SLUG[f.slug] ?? FileText;
              return (
                <Link
                  key={f.id}
                  href={`/school/${locationId}/staff-requests/${f.slug}?chrome=none`}
                  className="rounded-lg border border-slate-200 bg-white p-4 hover:border-blue-300 hover:shadow-sm transition"
                >
                  <Icon className="h-6 w-6 text-blue-600 mb-2" />
                  <div className="font-semibold text-slate-900">{f.display_name}</div>
                  {f.description ? (
                    <p className="text-xs text-slate-600 mt-1 line-clamp-3">{f.description}</p>
                  ) : null}
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
