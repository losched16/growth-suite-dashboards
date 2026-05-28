// /admin/[schoolId]/roster-import — operator-only roster importer.
//
// Paste a CSV → click Preview → review counts + errors → click Apply.
// All work happens via the /api/admin/schools/{schoolId}/roster-import
// endpoint; this page is just the UI.
//
// Operator-only via /admin/* proxy gate. The schools' iframe context
// can't see this route.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { query } from '@/lib/db';
import { RosterImportClient } from './RosterImportClient';

export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string }>;

export default async function RosterImportPage({ params }: { params: Params }) {
  const { schoolId } = await params;
  const { rows } = await query<{ id: string; name: string }>(
    `SELECT id, name FROM schools WHERE id = $1`, [schoolId],
  );
  if (rows.length === 0) notFound();
  const school = rows[0];

  return (
    <main className="flex flex-1 flex-col items-center bg-slate-50 p-6 min-h-screen">
      <div className="w-full max-w-4xl space-y-4">
        <Link
          href={`/admin/${schoolId}`}
          className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"
        >
          <ArrowLeft className="h-3 w-3" /> Back to {school.name}
        </Link>

        <header>
          <h1 className="text-2xl font-semibold text-slate-900">Roster CSV import — {school.name}</h1>
          <p className="mt-1 text-sm text-slate-500">
            Paste a CSV of families + parents + students. Click <strong>Preview</strong> to see what
            would happen (no DB writes). Click <strong>Apply</strong> to commit.
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
              <li><code className="font-mono">primary_parent_email</code> — used as the family's matching key</li>
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
              different student fields.
            </p>
            <p className="text-slate-600">
              Idempotent: existing families/parents/students are matched by email + DOB and reused. Re-running the same CSV is safe.
            </p>
          </div>
        </details>

        <RosterImportClient schoolId={schoolId} />
      </div>
    </main>
  );
}
