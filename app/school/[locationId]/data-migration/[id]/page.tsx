// /school/[locationId]/data-migration/[id] — review + adjust the proposed
// column → GHL-field mapping, see a dry-run plan of exactly what an apply would
// do, then (when enabled) apply it into GHL. Reading + the plan never touch GHL.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Save, AlertTriangle, Trash2, Rocket, Lock } from 'lucide-react';
import { query } from '@/lib/db';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { buildPlan, type MappingRow } from '@/lib/migration/csv-mapping';
import { loadMigrationTargets } from '@/lib/migration/targets';
import { commitAllowedFor } from '@/lib/migration/apply-to-ghl';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Params = Promise<{ locationId: string; id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;
type ColumnMeta = { name: string; sample_values: string[] };

export default async function ReviewPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { locationId, id } = await params;
  const sp = await searchParams;
  const msg = typeof sp.msg === 'string' ? sp.msg : null;
  const err = typeof sp.err === 'string' ? sp.err : null;
  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();

  const { rows } = await query<{
    filename: string | null; columns: ColumnMeta[]; mapping: MappingRow[];
    rows: Array<Record<string, string>>; row_count: number; status: string;
    applied_summary: { attempted: number; created: number; updated: number; errors: number } | null;
  }>(
    `SELECT filename, columns, mapping, rows, row_count, status, applied_summary
       FROM csv_migrations WHERE id = $1 AND school_id = $2`, [id, school.id]);
  if (rows.length === 0) notFound();
  const mig = rows[0];

  const targets = await loadMigrationTargets(school.id);
  const coreTargets = targets.filter((t) => t.kind === 'core');
  const customTargets = targets.filter((t) => t.kind === 'custom');
  const plan = buildPlan(mig.rows, mig.mapping);
  const mappingByCol = new Map(mig.mapping.map((m) => [m.csv_column, m]));
  const commitEnabled = commitAllowedFor(locationId);

  return (
    <main className="flex flex-1 flex-col items-center bg-slate-50 p-6 min-h-screen">
      <div className="w-full max-w-4xl space-y-4">
        <Link href={`/school/${locationId}/data-migration`} className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700">
          <ArrowLeft className="h-3 w-3" /> All imports
        </Link>
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-xl font-semibold text-slate-900">{mig.filename || 'upload.csv'}</h1>
          <span className="text-[11px] text-slate-500">{mig.row_count.toLocaleString()} rows</span>
        </div>

        {msg ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{msg}</div> : null}
        {err ? <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div> : null}

        {/* Dry-run plan */}
        <section className="rounded-xl border border-black/10 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-900">If you apply this mapping</h2>
          <div className="mt-2 grid grid-cols-3 gap-2 text-center">
            <Stat label="Contacts to import" value={plan.importable_rows} tone="emerald" />
            <Stat label="Fields mapped" value={plan.mapped_columns} tone="sky" />
            <Stat label="Rows skipped (no name/email)" value={plan.skipped_rows} tone="slate" />
          </div>
          {plan.warnings.map((w, i) => (
            <div key={i} className="mt-2 flex items-start gap-1.5 rounded-md bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {w}
            </div>
          ))}
          {plan.sample_contacts.length > 0 ? (
            <div className="mt-3">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Sample (first {plan.sample_contacts.length})</div>
              <div className="mt-1 space-y-0.5">
                {plan.sample_contacts.map((c, i) => (
                  <div key={i} className="text-[11px] text-slate-600">
                    {[c.firstName, c.lastName].filter(Boolean).join(' ') || '(no name)'}
                    {c.email ? ` · ${c.email}` : ''} · {c.fields} field{c.fields === 1 ? '' : 's'}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </section>

        {/* Mapping editor */}
        <form action={`/api/school/${locationId}/data-migration/${id}/save`} method="POST" className="rounded-xl border border-black/10 bg-white p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">Column mapping</h2>
            <button type="submit" className="inline-flex items-center gap-1.5 rounded-md bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700">
              <Save className="h-3.5 w-3.5" /> Save mapping
            </button>
          </div>
          <p className="mt-0.5 text-[11px] text-slate-500">Adjust any row. &ldquo;Don&rsquo;t import&rdquo; leaves that column out.</p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-[10px] uppercase tracking-wide text-slate-400">
                  <th className="py-1.5 pr-3 font-medium">Spreadsheet column</th>
                  <th className="py-1.5 pr-3 font-medium">Sample values</th>
                  <th className="py-1.5 font-medium">Maps to</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {mig.columns.map((col) => {
                  const m = mappingByCol.get(col.name);
                  const selected = m && m.target_key && !m.skip ? m.target_key : '__skip__';
                  const conf = m ? Math.round((m.confidence ?? 0) * 100) : 0;
                  return (
                    <tr key={col.name} className="align-top">
                      <td className="py-2 pr-3">
                        <div className="text-slate-800">{col.name}</div>
                        {m && !m.skip && m.method === 'heuristic' ? (
                          <span className={`text-[9px] ${conf >= 60 ? 'text-emerald-600' : 'text-amber-600'}`}>auto · {conf}%</span>
                        ) : m && m.method === 'manual' && !m.skip ? (
                          <span className="text-[9px] text-sky-600">you set this</span>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3 text-[11px] text-slate-500">
                        {(col.sample_values ?? []).slice(0, 3).map((v) => v.length > 24 ? v.slice(0, 24) + '…' : v).join(', ') || <span className="text-slate-300">(empty)</span>}
                      </td>
                      <td className="py-2">
                        <select name={`target__${col.name}`} defaultValue={selected}
                          className="w-full max-w-xs rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700">
                          <option value="__skip__">— Don&rsquo;t import —</option>
                          <optgroup label="Contact fields">
                            {coreTargets.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                          </optgroup>
                          <optgroup label="Your GHL fields">
                            {customTargets.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                          </optgroup>
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </form>

        {/* Apply */}
        <section className="rounded-xl border border-black/10 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-900">Apply to Growth Suite</h2>
          {mig.applied_summary ? (
            <div className="mt-1 rounded-md bg-emerald-50 px-3 py-2 text-[12px] text-emerald-800">
              Last applied: {mig.applied_summary.created} created, {mig.applied_summary.updated} updated
              {mig.applied_summary.errors > 0 ? `, ${mig.applied_summary.errors} errored` : ''} of {mig.applied_summary.attempted}.
            </div>
          ) : null}
          {commitEnabled ? (
            <form action={`/api/school/${locationId}/data-migration/${id}/apply`} method="POST" className="mt-2 flex flex-wrap items-end gap-2">
              <label className="text-[11px] text-slate-500">
                Limit rows (optional, for a test run)
                <input type="number" name="limit" min={1} placeholder="all" className="mt-0.5 block w-24 rounded border border-slate-300 px-2 py-1 text-xs" />
              </label>
              <button type="submit" className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700">
                <Rocket className="h-4 w-4" /> Apply {plan.importable_rows} contacts to GHL
              </button>
            </form>
          ) : (
            <div className="mt-2 flex items-start gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[12px] text-slate-600">
              <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
              <span>Applying to GHL is turned off for this account. The mapping + dry-run above are fully available; an administrator enables the write step per account once it&rsquo;s been verified.</span>
            </div>
          )}
        </section>

        <form action={`/api/school/${locationId}/data-migration/${id}/delete`} method="POST">
          <button type="submit" className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-rose-500">
            <Trash2 className="h-3 w-3" /> Delete this import
          </button>
        </form>
      </div>
    </main>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: 'emerald' | 'sky' | 'slate' }) {
  const c = tone === 'emerald' ? 'text-emerald-700' : tone === 'sky' ? 'text-sky-700' : 'text-slate-600';
  return (
    <div className="rounded-lg bg-slate-50 px-2 py-2.5">
      <div className={`text-xl font-semibold ${c}`}>{value.toLocaleString()}</div>
      <div className="text-[10px] text-slate-500">{label}</div>
    </div>
  );
}
