// /school/[locationId]/data-catalog — the self-adapting data layer's discovery
// hub. Shows the school their entire field + tag surface (auto-discovered from
// GHL on each sync), highlights what's NEW, flags any core field that vanished
// (possible break), and lets them add a discovered field to the Student Roster
// as a column or filter in one click (it promotes the field into the usable
// filter catalog and selects it — the roster already resolves the value).
//
// Reads our catalog + the roster config; writes happen via the add-to-roster
// route. No GHL writes.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Sparkles, Database, AlertTriangle, Plus, Check } from 'lucide-react';
import { query } from '@/lib/db';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { loadFieldCatalog } from '@/lib/sync/field-catalog';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type Params = Promise<{ locationId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const prettyType: Record<string, string> = {
  TEXT: 'Text', LARGE_TEXT: 'Long text', NUMERICAL: 'Number', PHONE: 'Phone',
  DATE: 'Date', MONETORY: 'Money', SINGLE_OPTIONS: 'Dropdown', MULTIPLE_OPTIONS: 'Multi-select',
  RADIO: 'Choice', CHECKBOX: 'Checkboxes',
};

export default async function DataCatalogPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { locationId } = await params;
  const sp = await searchParams;
  const msg = typeof sp.msg === 'string' ? sp.msg : null;
  const err = typeof sp.err === 'string' ? sp.err : null;
  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();

  const { fields, tags } = await loadFieldCatalog(school.id);
  const core = fields.filter((f) => f.is_core && !f.missing_since);
  const discovered = fields.filter((f) => !f.is_core && !f.missing_since);
  const missing = fields.filter((f) => f.missing_since && f.is_core);
  const shownTags = tags.filter((t) => !t.is_reserved);
  const newFieldCount = discovered.filter((f) => !f.surfaced).length;

  // Which discovered fields are already on the roster (as cf:<key>).
  const { rows: dashRows } = await query<{ layout: Array<{ widget_id: string; config: Record<string, unknown> }> }>(
    `SELECT layout FROM school_dashboards WHERE school_id = $1 AND dashboard_slug = 'student-roster'`,
    [school.id]);
  const rosterWidget = dashRows[0]?.layout?.find((w) => w.widget_id === 'student_roster_rich');
  const hasRoster = !!rosterWidget;
  const onCol = new Set((Array.isArray(rosterWidget?.config?.extra_columns) ? rosterWidget!.config.extra_columns as string[] : []));
  const onFilter = new Set((Array.isArray(rosterWidget?.config?.extra_filters) ? rosterWidget!.config.extra_filters as string[] : []));

  return (
    <main className="flex flex-1 flex-col items-center bg-slate-50 p-6 min-h-screen">
      <div className="w-full max-w-4xl space-y-4">
        <Link href={`/school/${locationId}/student-roster`} className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700">
          <ArrowLeft className="h-3 w-3" /> Back
        </Link>
        <div className="flex items-center gap-2">
          <Database className="h-5 w-5 text-emerald-700" />
          <h1 className="text-2xl font-semibold text-slate-900">Your data catalog</h1>
        </div>
        <p className="max-w-2xl text-sm text-slate-600">
          Every field and tag in your Growth Suite account, discovered automatically on each sync.
          Add any field you added in GHL straight to your Student Roster as a column or filter — in one click.
        </p>

        {msg ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{msg}</div> : null}
        {err ? <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div> : null}

        {newFieldCount > 0 ? (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
            <Sparkles className="h-4 w-4 shrink-0 text-emerald-700" />
            <span><span className="font-semibold">{newFieldCount} new field{newFieldCount === 1 ? '' : 's'}</span> discovered — add the ones you want to your roster below.</span>
          </div>
        ) : null}

        {missing.length > 0 ? (
          <div className="rounded-lg border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-900">
            <div className="flex items-center gap-1.5 font-semibold"><AlertTriangle className="h-4 w-4" /> {missing.length} core field{missing.length === 1 ? '' : 's'} disappeared from GHL</div>
            <p className="mt-0.5 text-[12px] text-rose-800">
              A standard field the platform depends on is no longer on your GHL location — this can silently
              empty dashboards. Contact your Growth Suite operator: {missing.map((m) => m.label || m.field_key).join(', ')}.
            </p>
          </div>
        ) : null}

        {!hasRoster ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            You don&rsquo;t have a Student Roster dashboard yet. Add it from{' '}
            <Link href={`/school/${locationId}/dashboards/new`} className="underline">Add dashboard</Link> to use fields as columns.
          </div>
        ) : null}

        {/* Discovered fields — one-click add to the roster */}
        <section className="rounded-xl border border-black/10 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-900">Discovered fields ({discovered.length})</h2>
          <p className="text-[11px] text-slate-500">Fields you added in GHL beyond the standard set.</p>
          {discovered.length === 0 ? (
            <p className="mt-2 text-xs text-slate-400">None yet. Add a custom field in GHL and it appears here after the next sync.</p>
          ) : (
            <div className="mt-3 divide-y divide-slate-100">
              {discovered.map((f) => {
                const attrKey = `cf:${f.field_key}`;
                const isCol = onCol.has(attrKey);
                const isFilter = onFilter.has(attrKey);
                const isChoice = (f.data_type ?? '').toUpperCase().includes('OPTION') || f.options.length > 0;
                return (
                  <div key={f.field_key} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm text-slate-800">
                        {f.label || f.field_key}
                        {!f.surfaced ? <span className="ml-2 rounded bg-emerald-100 px-1 py-0.5 text-[9px] font-semibold uppercase text-emerald-700">new</span> : null}
                      </div>
                      <div className="text-[10px] text-slate-400">
                        {prettyType[f.data_type ?? ''] ?? f.data_type ?? 'Text'}{f.options.length > 0 ? ` · ${f.options.length} options` : ''}
                      </div>
                    </div>
                    {hasRoster ? (
                      <div className="flex shrink-0 items-center gap-1.5">
                        {isCol ? (
                          <RemoveBtn locationId={locationId} fieldKey={f.field_key} kind="column" label="✓ Column" />
                        ) : (
                          <AddBtn locationId={locationId} fieldKey={f.field_key} kind="column" label="+ Column" />
                        )}
                        {isChoice ? (
                          isFilter
                            ? <RemoveBtn locationId={locationId} fieldKey={f.field_key} kind="filter" label="✓ Filter" />
                            : <AddBtn locationId={locationId} fieldKey={f.field_key} kind="filter" label="+ Filter" />
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Tags — informational; managed as roster filters via Customize roster */}
        <section className="rounded-xl border border-black/10 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-900">Tags in use ({shownTags.length})</h2>
          <p className="text-[11px] text-slate-500">
            Add tags as a roster column or filter from <Link href={`/school/${locationId}/roster-settings`} className="text-emerald-700 underline">Customize roster</Link>.
          </p>
          {shownTags.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {shownTags.map((t) => (
                <span key={t.tag} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">{t.tag} ({t.contact_count})</span>
              ))}
            </div>
          ) : <p className="mt-2 text-xs text-slate-400">No tags in use yet.</p>}
        </section>

        <details className="rounded-xl border border-black/10 bg-white p-4">
          <summary className="cursor-pointer text-sm font-semibold text-slate-900">Standard fields ({core.length}) — always available</summary>
          <p className="mt-1 text-[11px] text-slate-500">The platform&rsquo;s core field set — protected and always usable.</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {core.map((f) => <span key={f.field_key} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">{f.label || f.field_key}</span>)}
          </div>
        </details>
      </div>
    </main>
  );
}

function AddBtn({ locationId, fieldKey, kind, label }: { locationId: string; fieldKey: string; kind: string; label: string }) {
  return (
    <form action={`/api/school/${locationId}/data-catalog/add-to-roster`} method="POST">
      <input type="hidden" name="field_key" value={fieldKey} />
      <input type="hidden" name="kind" value={kind} />
      <button type="submit" className="inline-flex items-center gap-1 rounded border border-emerald-300 bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-800 hover:bg-emerald-100">
        <Plus className="h-3 w-3" /> {label}
      </button>
    </form>
  );
}

function RemoveBtn({ locationId, fieldKey, kind, label }: { locationId: string; fieldKey: string; kind: string; label: string }) {
  return (
    <form action={`/api/school/${locationId}/data-catalog/add-to-roster`} method="POST" title="Click to remove from the roster">
      <input type="hidden" name="field_key" value={fieldKey} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="remove" value="1" />
      <button type="submit" className="inline-flex items-center gap-1 rounded border border-slate-300 bg-slate-50 px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-100">
        <Check className="h-3 w-3 text-emerald-600" /> {label}
      </button>
    </form>
  );
}
