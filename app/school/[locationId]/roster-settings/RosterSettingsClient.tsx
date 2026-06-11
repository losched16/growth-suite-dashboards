'use client';

// Self-serve picker: searchable list of every catalog attribute with a
// "Filter" and a "Column" checkbox each. Saves to the roster widget
// config via /api/school/roster-settings.

import { useMemo, useState } from 'react';
import { Search, Loader2, Check, Tags, GitBranch, ListFilter, LayoutList } from 'lucide-react';
import { AVAILABLE_COLUMNS, AVAILABLE_FILTERS, DETAIL_SECTIONS } from '@/lib/widgets/components/StudentRosterRich/config';
import type { CatalogAttr } from './page';

const TYPE_LABEL: Record<string, string> = {
  tag: 'Tags',
  opportunity_stage: 'Opportunities',
  opportunity_status: 'Opportunities',
  pipeline: 'Opportunities',
  custom_field: 'Contact fields',
};

export function RosterSettingsClient({
  locationId, schoolId, attrs, initialFilters, initialColumns,
  initialStaticColumns, initialStaticFilters,
  initialDetailAttrs, initialDetailSections,
}: {
  locationId: string;
  schoolId: string;
  attrs: CatalogAttr[];
  initialFilters: string[];
  initialColumns: string[];
  initialStaticColumns: string[];
  initialStaticFilters: string[];
  initialDetailAttrs: string[];
  // null = never customized → all built-in sections on
  initialDetailSections: string[] | null;
}) {
  const [filters, setFilters] = useState<Set<string>>(new Set(initialFilters));
  const [columns, setColumns] = useState<Set<string>>(new Set(initialColumns));
  const [staticCols, setStaticCols] = useState<Set<string>>(new Set(initialStaticColumns));
  const [staticFils, setStaticFils] = useState<Set<string>>(new Set(initialStaticFilters));
  const [detailAttrs, setDetailAttrs] = useState<Set<string>>(new Set(initialDetailAttrs));
  const [detailSections, setDetailSections] = useState<Set<string>>(
    new Set(initialDetailSections ?? DETAIL_SECTIONS.map((s) => s.key)));
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Rebuild ordered arrays on save: keep the school's existing order
  // for items still on, append newly-enabled ones in canonical order.
  function ordered(initial: string[], selected: Set<string>, canonical: string[]): string[] {
    const kept = initial.filter((k) => selected.has(k));
    const added = canonical.filter((k) => selected.has(k) && !initial.includes(k));
    return [...kept, ...added];
  }

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const visible = attrs.filter((a) =>
      !q || a.label.toLowerCase().includes(q) || a.attr_key.toLowerCase().includes(q));
    const byGroup = new Map<string, CatalogAttr[]>();
    for (const a of visible) {
      const g = TYPE_LABEL[a.attr_type] ?? 'Other';
      const list = byGroup.get(g) ?? [];
      list.push(a);
      byGroup.set(g, list);
    }
    // Stable group order
    return ['Tags', 'Opportunities', 'Contact fields', 'Other']
      .filter((g) => byGroup.has(g))
      .map((g) => ({ group: g, items: byGroup.get(g)! }));
  }, [attrs, search]);

  function toggle(set: Set<string>, setter: (s: Set<string>) => void, key: string) {
    const next = new Set(set);
    if (next.has(key)) next.delete(key); else next.add(key);
    setter(next);
    setSaved(false);
  }

  async function save() {
    setBusy(true); setErr(null); setSaved(false);
    try {
      const r = await fetch('/api/school/roster-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          school_id: schoolId,
          extra_filters: [...filters],
          extra_columns: [...columns],
          shown_columns: ordered(initialStaticColumns, staticCols, AVAILABLE_COLUMNS.map((c) => c.key)),
          shown_filters: ordered(initialStaticFilters, staticFils, AVAILABLE_FILTERS.map((f) => f.key)),
          detail_attrs: [...detailAttrs],
          detail_sections: DETAIL_SECTIONS.map((s) => s.key).filter((k) => detailSections.has(k)),
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j.detail || j.error || `HTTP ${r.status}`); return; }
      setSaved(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const selectedCount = filters.size + columns.size;

  return (
    <div className="space-y-3">
      {/* Sticky action bar */}
      <div className="sticky top-0 z-10 flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
        <div className="flex flex-1 items-center gap-2 rounded-md border border-slate-300 px-2 py-1.5">
          <Search className="h-4 w-4 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${attrs.length} attributes…`}
            className="flex-1 text-sm outline-none"
          />
        </div>
        <span className="text-xs text-slate-500">{staticFils.size + filters.size} filters · {staticCols.size + columns.size} columns</span>
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4" /> : null}
          {busy ? 'Saving…' : saved ? 'Saved' : 'Save'}
        </button>
      </div>
      {err ? <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{err}</div> : null}
      {saved ? (
        <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          Saved. <a href={`/school/${locationId}/student-roster`} className="underline font-medium">Open the Student Roster →</a>
        </div>
      ) : null}

      {/* Built-in roster columns & filters — current state, toggleable */}
      {(() => {
        const q = search.trim().toLowerCase();
        const cols = AVAILABLE_COLUMNS.filter((c) => !q || c.label.toLowerCase().includes(q) || c.key.includes(q));
        const fils = AVAILABLE_FILTERS.filter((f) => !q || f.label.toLowerCase().includes(q) || f.key.includes(q));
        if (cols.length === 0 && fils.length === 0) return null;
        return (
          <section className="rounded-lg border border-slate-200 bg-white overflow-hidden">
            <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50 px-4 py-2 text-sm font-semibold text-slate-700">
              <LayoutList className="h-4 w-4 text-violet-600" />
              Built-in <span className="font-normal text-slate-400">({cols.length} columns · {fils.length} filters)</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-slate-100">
              <div>
                <div className="px-4 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Columns</div>
                <ul className="divide-y divide-slate-50 max-h-[24rem] overflow-y-auto">
                  {cols.map((c) => (
                    <li key={c.key} className="flex items-center justify-between gap-3 px-4 py-1.5 hover:bg-slate-50">
                      <span className={`text-sm ${staticCols.has(c.key) ? 'text-slate-900 font-medium' : 'text-slate-500'}`}>{c.label}</span>
                      <label className="flex items-center gap-1 text-xs text-slate-600">
                        <input
                          type="checkbox"
                          checked={staticCols.has(c.key)}
                          onChange={() => toggle(staticCols, setStaticCols, c.key)}
                          className="h-4 w-4 rounded border-slate-300"
                        />
                        On
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <div className="px-4 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Filters</div>
                <ul className="divide-y divide-slate-50 max-h-[24rem] overflow-y-auto">
                  {fils.map((f) => (
                    <li key={f.key} className="flex items-center justify-between gap-3 px-4 py-1.5 hover:bg-slate-50">
                      <span className={`text-sm ${staticFils.has(f.key) ? 'text-slate-900 font-medium' : 'text-slate-500'}`}>{f.label}</span>
                      <label className="flex items-center gap-1 text-xs text-slate-600">
                        <input
                          type="checkbox"
                          checked={staticFils.has(f.key)}
                          onChange={() => toggle(staticFils, setStaticFils, f.key)}
                          className="h-4 w-4 rounded border-slate-300"
                        />
                        On
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            {/* Row-dropdown sections — what shows when a row is expanded */}
            <div className="border-t border-slate-100">
              <div className="px-4 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                Row dropdown (what shows when you expand a student)
              </div>
              <ul className="divide-y divide-slate-50">
                {DETAIL_SECTIONS.map((s) => (
                  <li key={s.key} className="flex items-center justify-between gap-3 px-4 py-1.5 hover:bg-slate-50">
                    <span className={`text-sm ${detailSections.has(s.key) ? 'text-slate-900 font-medium' : 'text-slate-500'}`}>{s.label}</span>
                    <label className="flex items-center gap-1 text-xs text-slate-600">
                      <input
                        type="checkbox"
                        checked={detailSections.has(s.key)}
                        onChange={() => toggle(detailSections, setDetailSections, s.key)}
                        className="h-4 w-4 rounded border-slate-300"
                      />
                      On
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        );
      })()}

      {groups.map(({ group, items }) => (
        <section key={group} className="rounded-lg border border-slate-200 bg-white overflow-hidden">
          <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50 px-4 py-2 text-sm font-semibold text-slate-700">
            {group === 'Tags' ? <Tags className="h-4 w-4 text-emerald-600" />
              : group === 'Opportunities' ? <GitBranch className="h-4 w-4 text-blue-600" />
              : <ListFilter className="h-4 w-4 text-slate-500" />}
            {group} <span className="font-normal text-slate-400">({items.length})</span>
          </div>
          <ul className="divide-y divide-slate-100 max-h-[28rem] overflow-y-auto">
            {items.map((a) => (
              <li key={a.attr_key} className="flex items-center gap-3 px-4 py-2 hover:bg-slate-50">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-slate-900 truncate">{a.label}</div>
                  <div className="text-[11px] text-slate-500 truncate">
                    {a.value_count} contact{a.value_count === 1 ? '' : 's'}
                    {a.sample_values.length > 0 ? <> · e.g. {a.sample_values.slice(0, 3).join(' · ')}</> : null}
                  </div>
                </div>
                <label className="flex items-center gap-1 text-xs text-slate-600 whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={filters.has(a.attr_key)}
                    onChange={() => toggle(filters, setFilters, a.attr_key)}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  Filter
                </label>
                <label className="flex items-center gap-1 text-xs text-slate-600 whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={columns.has(a.attr_key)}
                    onChange={() => toggle(columns, setColumns, a.attr_key)}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  Column
                </label>
                <label className="flex items-center gap-1 text-xs text-slate-600 whitespace-nowrap" title="Show in the row dropdown when a student is expanded">
                  <input
                    type="checkbox"
                    checked={detailAttrs.has(a.attr_key)}
                    onChange={() => toggle(detailAttrs, setDetailAttrs, a.attr_key)}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  Details
                </label>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
