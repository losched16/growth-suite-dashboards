// /school/[locationId]/data-migration — upload a legacy CSV export and see
// past migrations. The engine proposes a column → GHL-field mapping you review
// before anything is written. Nothing here touches GHL.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Upload, FileSpreadsheet, ChevronRight } from 'lucide-react';
import { query } from '@/lib/db';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type Params = Promise<{ locationId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const STATUS_STYLE: Record<string, string> = {
  proposed: 'bg-amber-100 text-amber-700',
  reviewed: 'bg-sky-100 text-sky-700',
  applied: 'bg-emerald-100 text-emerald-700',
};

export default async function DataMigrationPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { locationId } = await params;
  const sp = await searchParams;
  const msg = typeof sp.msg === 'string' ? sp.msg : null;
  const err = typeof sp.err === 'string' ? sp.err : null;
  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();

  const { rows: migrations } = await query<{ id: string; filename: string | null; row_count: number; status: string; created_at: string }>(
    `SELECT id, filename, row_count, status, created_at FROM csv_migrations
      WHERE school_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [school.id]);

  return (
    <main className="flex flex-1 flex-col items-center bg-slate-50 p-6 min-h-screen">
      <div className="w-full max-w-3xl space-y-4">
        <Link href={`/school/${locationId}/data-catalog`} className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700">
          <ArrowLeft className="h-3 w-3" /> Back to data catalog
        </Link>
        <div className="flex items-center gap-2">
          <FileSpreadsheet className="h-5 w-5 text-emerald-700" />
          <h1 className="text-2xl font-semibold text-slate-900">Import from a spreadsheet</h1>
        </div>
        <p className="max-w-2xl text-sm text-slate-600">
          Upload a CSV export from your old system (FACTS, TADS, Brightwheel, or a plain roster).
          Growth Suite reads the columns and proposes where each one maps in your account. You review
          and adjust the mapping — <span className="font-medium">nothing is written until you apply it</span>.
        </p>

        {msg ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{msg}</div> : null}
        {err ? <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div> : null}

        <form action={`/api/school/${locationId}/data-migration/upload`} method="POST" encType="multipart/form-data"
          className="rounded-xl border border-dashed border-emerald-300 bg-white p-5">
          <label className="block text-sm font-medium text-slate-800">Choose a CSV file</label>
          <p className="mt-0.5 text-[11px] text-slate-500">The first row must be the column headers. Up to 5,000 rows / 8 MB.</p>
          <div className="mt-3 flex items-center gap-2">
            <input type="file" name="file" accept=".csv,text/csv" required
              className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-emerald-600 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-emerald-700" />
            <button type="submit" className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700">
              <Upload className="h-4 w-4" /> Upload
            </button>
          </div>
        </form>

        <section className="rounded-xl border border-black/10 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-900">Recent imports</h2>
          {migrations.length === 0 ? (
            <p className="mt-2 text-xs text-slate-400">No imports yet.</p>
          ) : (
            <div className="mt-2 divide-y divide-slate-100">
              {migrations.map((m) => (
                <Link key={m.id} href={`/school/${locationId}/data-migration/${m.id}`}
                  className="flex items-center justify-between gap-3 py-2.5 hover:bg-slate-50">
                  <div className="min-w-0">
                    <div className="truncate text-sm text-slate-800">{m.filename || 'upload.csv'}</div>
                    <div className="text-[10px] text-slate-400">{m.row_count.toLocaleString()} rows · {new Date(m.created_at).toLocaleDateString()}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${STATUS_STYLE[m.status] ?? 'bg-slate-100 text-slate-600'}`}>{m.status}</span>
                    <ChevronRight className="h-4 w-4 text-slate-300" />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
