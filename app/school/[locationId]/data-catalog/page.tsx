// /school/[locationId]/data-catalog — the self-adapting data layer's discovery
// hub. Shows the school their entire field + tag surface (auto-discovered from
// GHL on each sync), highlights what's NEW since they last looked, and lets
// them mark discovered items "for use" — which clears them from the new-items
// prompt and flags them to add as columns/filters. Core fields (the platform's
// ~150) are shown read-only; a core field that has gone missing in GHL is
// surfaced as an alert (possible break).
//
// Reads our catalog (populated by lib/sync/field-catalog) + writes only the
// `surfaced` flag. No GHL writes.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Sparkles, Database, AlertTriangle } from 'lucide-react';
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
  const missing = fields.filter((f) => f.missing_since && f.is_core); // core that vanished = alert
  const surfacableTags = tags.filter((t) => !t.is_reserved);

  const newFieldCount = discovered.filter((f) => !f.surfaced).length;
  const newTagCount = surfacableTags.filter((t) => !t.surfaced).length;

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
          Anything you add in GHL later shows up here — mark what you want to use, then add it as a
          column or filter from <Link href={`/school/${locationId}/roster-settings`} className="text-emerald-700 underline">Customize roster</Link>.
        </p>

        {msg ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{msg}</div> : null}
        {err ? <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div> : null}

        {(newFieldCount > 0 || newTagCount > 0) ? (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
            <Sparkles className="h-4 w-4 shrink-0 text-emerald-700" />
            <span>
              <span className="font-semibold">
                {newFieldCount > 0 ? `${newFieldCount} new field${newFieldCount === 1 ? '' : 's'}` : ''}
                {newFieldCount > 0 && newTagCount > 0 ? ' and ' : ''}
                {newTagCount > 0 ? `${newTagCount} new tag${newTagCount === 1 ? '' : 's'}` : ''}
              </span>{' '}
              discovered and ready to use — check the ones you want below, then Save.
            </span>
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

        <form action={`/api/school/${locationId}/data-catalog/surface`} method="POST" className="space-y-5">
          <input type="hidden" name="all_fields" value={discovered.map((f) => f.field_key).join('\n')} />
          <input type="hidden" name="all_tags" value={surfacableTags.map((t) => t.tag).join('\n')} />

          {/* Discovered (non-core) fields — the ones a school surfaces */}
          <section className="rounded-xl border border-black/10 bg-white p-4">
            <h2 className="text-sm font-semibold text-slate-900">Discovered fields ({discovered.length})</h2>
            <p className="text-[11px] text-slate-500">Fields you added in GHL beyond the standard set. Check to use them on dashboards.</p>
            {discovered.length === 0 ? (
              <p className="mt-2 text-xs text-slate-400">None yet. Add a custom field in GHL and it appears here after the next sync.</p>
            ) : (
              <div className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {discovered.map((f) => (
                  <label key={f.field_key} className={`flex items-start gap-2 rounded border px-2 py-1.5 text-sm ${f.surfaced ? 'border-emerald-200 bg-emerald-50/40' : 'border-slate-200'}`}>
                    <input type="checkbox" name="field" value={f.field_key} defaultChecked={f.surfaced} className="mt-0.5 h-4 w-4 rounded border-slate-300" />
                    <span className="min-w-0">
                      <span className="block truncate text-slate-800">{f.label || f.field_key}</span>
                      <span className="block text-[10px] text-slate-400">
                        {prettyType[f.data_type ?? ''] ?? f.data_type ?? 'Text'}
                        {f.options.length > 0 ? ` · ${f.options.length} options` : ''}
                        {!f.surfaced ? ' · new' : ''}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </section>

          {/* Tags */}
          <section className="rounded-xl border border-black/10 bg-white p-4">
            <h2 className="text-sm font-semibold text-slate-900">Tags ({surfacableTags.length})</h2>
            <p className="text-[11px] text-slate-500">Tags in use on your contacts. Check to use as filters. (Reserved platform tags are hidden.)</p>
            {surfacableTags.length === 0 ? (
              <p className="mt-2 text-xs text-slate-400">No tags in use yet.</p>
            ) : (
              <div className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-3">
                {surfacableTags.map((t) => (
                  <label key={t.tag} className={`flex items-center gap-2 rounded border px-2 py-1.5 text-sm ${t.surfaced ? 'border-emerald-200 bg-emerald-50/40' : 'border-slate-200'}`}>
                    <input type="checkbox" name="tag" value={t.tag} defaultChecked={t.surfaced} className="h-4 w-4 rounded border-slate-300" />
                    <span className="min-w-0 truncate text-slate-800">{t.tag} <span className="text-[10px] text-slate-400">({t.contact_count})</span></span>
                  </label>
                ))}
              </div>
            )}
          </section>

          <button type="submit" className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">
            Save selections
          </button>
        </form>

        {/* Core fields — informational, read-only */}
        <details className="rounded-xl border border-black/10 bg-white p-4">
          <summary className="cursor-pointer text-sm font-semibold text-slate-900">Standard fields ({core.length}) — always available</summary>
          <p className="mt-1 text-[11px] text-slate-500">The platform&rsquo;s core field set. These are protected and always usable; no need to enable them.</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {core.map((f) => (
              <span key={f.field_key} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">{f.label || f.field_key}</span>
            ))}
          </div>
        </details>
      </div>
    </main>
  );
}
