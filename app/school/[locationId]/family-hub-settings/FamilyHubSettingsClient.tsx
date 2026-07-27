'use client';

// Self-serve picker for the Family Hub: searchable list of every catalog
// attribute with a "Column" and a "Details" checkbox each. Columns are
// added to the family table; Details rows show inside the expanded family
// report. Saves to the family_hub_table widget config via
// /api/school/family-hub-settings. Ported from RosterSettingsClient
// (filters + built-in-column toggles + detail-section toggles dropped —
// the Family Hub v1 exposes only added columns + detail rows).

import { useMemo, useState } from 'react';
import { Search, Loader2, Check, Tags, GitBranch, ListFilter, ArrowUp, ArrowDown, GripVertical } from 'lucide-react';
import { AVAILABLE_COLUMNS, orderColumns } from '@/lib/widgets/components/FamilyHubTable/config';
import type { CatalogAttr } from './page';

const TYPE_LABEL: Record<string, string> = {
  tag: 'Tags',
  opportunity_stage: 'Opportunities',
  opportunity_status: 'Opportunities',
  pipeline: 'Opportunities',
  custom_field: 'Contact fields',
  facts: 'FACTS billing',
};

export function FamilyHubSettingsClient({
  locationId, schoolId, attrs,
  initialColumns, initialDetailAttrs, initialShownColumns, initialColumnOrder,
}: {
  locationId: string;
  schoolId: string;
  attrs: CatalogAttr[];
  // Catalog attr_keys currently added as columns / detail rows.
  initialColumns: string[];
  initialDetailAttrs: string[];
  // Built-in columns already on the hub (fixed here — only used to seed
  // the column-order list so added columns can be arranged around them).
  initialShownColumns: string[];
  initialColumnOrder: string[];
}) {
  const [columns, setColumns] = useState<Set<string>>(new Set(initialColumns));
  const [detailAttrs, setDetailAttrs] = useState<Set<string>>(new Set(initialDetailAttrs));
  const [colOrder, setColOrder] = useState<string[]>(initialColumnOrder);
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
    return ['Tags', 'Opportunities', 'FACTS billing', 'Contact fields', 'Other']
      .filter((g) => byGroup.has(g))
      .map((g) => ({ group: g, items: byGroup.get(g)! }));
  }, [attrs, search]);

  function toggle(set: Set<string>, setter: (s: Set<string>) => void, key: string) {
    const next = new Set(set);
    if (next.has(key)) next.delete(key); else next.add(key);
    setter(next);
    setSaved(false);
  }

  // Label for any column key (built-in family-hub column or added catalog attr).
  const colLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of AVAILABLE_COLUMNS) m.set(c.key as string, c.label);
    for (const a of attrs) m.set(a.attr_key, a.label);
    return m;
  }, [attrs]);

  // The currently-rendered columns in natural order (built-in shown ones
  // first, in canonical order, then the added catalog columns), reordered
  // by the saved order. This is the live list the reorder controls act on.
  const enabledNatural = useMemo(() => ([
    ...AVAILABLE_COLUMNS.map((c) => c.key as string).filter((k) => initialShownColumns.includes(k)),
    ...[...columns],
  ]), [initialShownColumns, columns]);
  const orderedColumns = useMemo(
    () => orderColumns(colOrder, enabledNatural),
    [colOrder, enabledNatural],
  );

  function moveColumn(index: number, dir: -1 | 1) {
    const arr = [...orderedColumns];
    const j = index + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[index], arr[j]] = [arr[j], arr[index]];
    setColOrder(arr);
    setSaved(false);
  }

  async function save() {
    setBusy(true); setErr(null); setSaved(false);
    try {
      const r = await fetch('/api/school/family-hub-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          school_id: schoolId,
          extra_columns: [...columns],
          detail_attrs: [...detailAttrs],
          column_order: orderedColumns,
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
        <span className="text-xs text-slate-500">{columns.size} columns · {detailAttrs.size} detail rows</span>
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
          Saved. <a href={`/school/${locationId}/family-hub`} className="underline font-medium">Open the Family Hub →</a>
        </div>
      ) : null}

      {/* Column order — reorder the columns currently on the table
          (built-in + your added ones). */}
      <section className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50 px-4 py-2 text-sm font-semibold text-slate-700">
          <GripVertical className="h-4 w-4 text-blue-600" />
          Column order
          <span className="font-normal text-slate-400">— move columns up/down to arrange your table ({orderedColumns.length})</span>
        </div>
        {orderedColumns.length === 0 ? (
          <div className="px-4 py-3 text-sm text-slate-500 italic">Turn on some columns below, then arrange them here.</div>
        ) : (
          <ul className="divide-y divide-slate-50">
            {orderedColumns.map((key, i) => (
              <li key={key} className="flex items-center justify-between gap-3 px-4 py-1.5 hover:bg-slate-50">
                <span className="flex items-center gap-2 text-sm text-slate-800">
                  <span className="w-5 text-right text-[11px] tabular-nums text-slate-400">{i + 1}</span>
                  {colLabel.get(key) ?? key}
                </span>
                <span className="flex items-center gap-1">
                  <button type="button" onClick={() => moveColumn(i, -1)} disabled={i === 0}
                    className="rounded border border-slate-300 p-0.5 text-slate-600 hover:bg-slate-100 disabled:opacity-30" title="Move up">
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                  <button type="button" onClick={() => moveColumn(i, 1)} disabled={i === orderedColumns.length - 1}
                    className="rounded border border-slate-300 p-0.5 text-slate-600 hover:bg-slate-100 disabled:opacity-30" title="Move down">
                    <ArrowDown className="h-3.5 w-3.5" />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

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
                    checked={columns.has(a.attr_key)}
                    onChange={() => toggle(columns, setColumns, a.attr_key)}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  Column
                </label>
                <label className="flex items-center gap-1 text-xs text-slate-600 whitespace-nowrap" title="Show as an extra row inside the expanded family report">
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
