'use client';

// Self-serve picker: searchable list of every catalog attribute with a
// "Filter" and a "Column" checkbox each. Saves to the roster widget
// config via /api/school/roster-settings.

import { useMemo, useState } from 'react';
import { Search, Loader2, Check, Tags, GitBranch, ListFilter } from 'lucide-react';
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
}: {
  locationId: string;
  schoolId: string;
  attrs: CatalogAttr[];
  initialFilters: string[];
  initialColumns: string[];
}) {
  const [filters, setFilters] = useState<Set<string>>(new Set(initialFilters));
  const [columns, setColumns] = useState<Set<string>>(new Set(initialColumns));
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
        <span className="text-xs text-slate-500">{filters.size} filters · {columns.size} columns</span>
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
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
