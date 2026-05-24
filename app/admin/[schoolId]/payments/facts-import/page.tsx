// /admin/[schoolId]/payments/facts-import — operator uploads a FACTS
// CSV export. We auto-detect headers, surface a column-mapping form
// (pre-filled from the saved mapping if any), preview the result,
// and on commit create/update family_tuition_enrollments.
//
// Loads the saved mapping + recent imports for context.

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { Upload, FileText, CheckCircle2, AlertCircle } from 'lucide-react';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { query } from '@/lib/db';
import { FactsImportClient } from './FactsImportClient';

export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string }>;

interface MappingRow {
  field_mapping: Record<string, string>;
  plan_name_aliases: Record<string, string>;
  academic_year: string | null;
  last_used_at: string | null;
}

interface RecentImportRow {
  id: string;
  academic_year: string;
  status: string;
  total_rows: number;
  rows_matched: number;
  rows_inserted: number;
  rows_updated: number;
  rows_skipped: number;
  rows_errored: number;
  created_at: string;
  initiated_by: string | null;
}

interface PlanRow {
  id: string;
  slug: string;
  display_name: string;
}

export default async function FactsImportPage({ params }: { params: Params }) {
  const ck = await cookies();
  if (!verifySessionToken(ck.get(SESSION_COOKIE)?.value)) redirect('/login');
  const { schoolId } = await params;

  const { rows: schoolRows } = await query<{ id: string; name: string }>(
    `SELECT id, name FROM schools WHERE id = $1`, [schoolId],
  );
  if (schoolRows.length === 0) notFound();
  const school = schoolRows[0];

  // Saved mapping (may be empty for first-time imports)
  const { rows: mapping } = await query<MappingRow>(
    `SELECT field_mapping, plan_name_aliases, academic_year, last_used_at::text
       FROM school_facts_import_mappings WHERE school_id = $1`,
    [schoolId],
  );
  const savedMapping = mapping[0] ?? {
    field_mapping: {},
    plan_name_aliases: {},
    academic_year: '2026-27',
    last_used_at: null,
  };

  // Recent imports
  const { rows: recent } = await query<RecentImportRow>(
    `SELECT id, academic_year, status, total_rows, rows_matched, rows_inserted,
            rows_updated, rows_skipped, rows_errored, created_at::text, initiated_by
       FROM school_facts_imports
      WHERE school_id = $1
      ORDER BY created_at DESC
      LIMIT 5`,
    [schoolId],
  );

  // School's payment plans (for the operator to see what the import can map to)
  const { rows: plans } = await query<PlanRow>(
    `SELECT id, slug, display_name FROM payment_plans
      WHERE school_id = $1 AND is_active = true ORDER BY position ASC`,
    [schoolId],
  );

  return (
    <div className="space-y-5 max-w-6xl">
      <div>
        <Link href={`/admin/${schoolId}/payments`} className="text-xs text-gray-500 hover:text-gray-700">
          ← Back to Payments
        </Link>
      </div>

      <header>
        <h1 className="text-2xl font-semibold text-gray-900">FACTS CSV import</h1>
        <p className="mt-1 text-sm text-gray-600">
          Paste {school.name}&rsquo;s FACTS Tuition Management export here. We&rsquo;ll detect the
          columns, you confirm the mapping, then we create or update each family&rsquo;s tuition
          enrollment with the actual amounts.
        </p>
      </header>

      {/* Recent imports */}
      {recent.length > 0 ? (
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Recent imports</h2>
          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
            <table className="w-full text-xs">
              <thead className="border-b border-gray-100 bg-gray-50 text-left text-[10px] uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-3 py-2 font-medium">When</th>
                  <th className="px-3 py-2 font-medium">Year</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium text-right">Rows</th>
                  <th className="px-3 py-2 font-medium text-right">Inserted</th>
                  <th className="px-3 py-2 font-medium text-right">Updated</th>
                  <th className="px-3 py-2 font-medium text-right">Skipped</th>
                  <th className="px-3 py-2 font-medium text-right">Errors</th>
                  <th className="px-3 py-2 font-medium">By</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {recent.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-2">{new Date(r.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</td>
                    <td className="px-3 py-2">{r.academic_year}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-block rounded-full px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide ${
                        r.status === 'committed' ? 'bg-emerald-100 text-emerald-800' :
                        r.status === 'failed'    ? 'bg-rose-100 text-rose-800' :
                        r.status === 'aborted'   ? 'bg-slate-100 text-slate-700' :
                                                   'bg-amber-100 text-amber-800'
                      }`}>{r.status}</span>
                    </td>
                    <td className="px-3 py-2 text-right">{r.total_rows}</td>
                    <td className="px-3 py-2 text-right text-emerald-700">{r.rows_inserted}</td>
                    <td className="px-3 py-2 text-right text-blue-700">{r.rows_updated}</td>
                    <td className="px-3 py-2 text-right text-amber-700">{r.rows_skipped}</td>
                    <td className="px-3 py-2 text-right text-rose-700">{r.rows_errored}</td>
                    <td className="px-3 py-2 text-[10px] text-gray-600">{r.initiated_by ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {/* Saved mapping context */}
      {savedMapping.last_used_at ? (
        <div className="rounded-md border border-blue-200 bg-blue-50/40 px-3 py-2 text-xs text-blue-900">
          <div className="font-medium">Saved column mapping from previous import</div>
          <div className="mt-0.5 text-blue-800">
            We&rsquo;ll pre-fill the mapping below with what worked last time. Adjust if FACTS
            changed their export format.
          </div>
        </div>
      ) : null}

      <FactsImportClient
        schoolId={schoolId}
        academicYear={savedMapping.academic_year ?? '2026-27'}
        savedMapping={savedMapping.field_mapping}
        planAliases={savedMapping.plan_name_aliases}
        availablePlans={plans}
      />
    </div>
  );
}
