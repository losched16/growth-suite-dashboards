// /school/[locationId]/roster-import — school-facing self-serve roster
// importer. Upload (or paste) a CSV of families + parents + students,
// preview what would change, then apply. Same engine as the operator
// page (/admin/[schoolId]/roster-import); only the auth posture and
// chrome differ. Standalone schools reach this from the side nav after
// signing in via the staff magic link.

import { notFound } from 'next/navigation';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { RosterImportClient } from '@/components/roster/RosterImportClient';

export const dynamic = 'force-dynamic';

type Params = Promise<{ locationId: string }>;

export default async function SchoolRosterImportPage({ params }: { params: Params }) {
  const { locationId } = await params;
  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">Import roster</h1>
        <p className="mt-1 text-sm text-slate-500">
          Upload a CSV of families, parents, and students. Click <strong>Preview</strong> to see what
          would happen (nothing is saved). Click <strong>Apply</strong> to commit. Re-running the same
          file is safe — existing families, parents, and students are matched and reused.
        </p>
      </header>

      <details className="rounded-lg border border-slate-200 bg-slate-50/50 p-3">
        <summary className="cursor-pointer text-sm font-semibold text-slate-700">
          Expected CSV columns
        </summary>
        <div className="mt-2 text-xs text-slate-700 space-y-2">
          <p>Required columns (case-insensitive headers; snake_case or Title Case both work):</p>
          <ul className="ml-4 list-disc space-y-0.5">
            <li><code className="font-mono">family_name</code> — e.g. &quot;Smith Family&quot;</li>
            <li><code className="font-mono">primary_parent_first</code></li>
            <li><code className="font-mono">primary_parent_last</code></li>
            <li><code className="font-mono">primary_parent_email</code> — used as the family&apos;s matching key</li>
            <li><code className="font-mono">student_first</code></li>
            <li><code className="font-mono">student_last</code></li>
            <li><code className="font-mono">student_dob</code> — YYYY-MM-DD or MM/DD/YYYY</li>
          </ul>
          <p>Optional columns:</p>
          <ul className="ml-4 list-disc space-y-0.5">
            <li><code className="font-mono">primary_parent_phone</code></li>
            <li><code className="font-mono">second_parent_first / second_parent_last / second_parent_email / second_parent_phone</code></li>
            <li><code className="font-mono">classroom</code> — e.g. &quot;Sunflower&quot;</li>
            <li><code className="font-mono">program</code> — e.g. &quot;Primary&quot;</li>
          </ul>
          <p className="text-slate-600">
            One row per student. Siblings = multiple rows with identical family + parent fields,
            different student fields. The <strong>Download template</strong> button below gives you a
            starter file with the right headers.
          </p>
        </div>
      </details>

      <RosterImportClient
        schoolId={school.id}
        endpoint="/api/school/roster-import"
        sendSchoolId
        doneHref={`/school/${locationId}/student-roster`}
        doneLabel="View student roster"
      />
    </div>
  );
}
