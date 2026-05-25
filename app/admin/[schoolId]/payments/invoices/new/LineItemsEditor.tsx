'use client';

// Inline line-item editor. Adds/removes rows client-side; submits as
// indexed form fields (line_description_<i>, line_quantity_<i>,
// line_unit_amount_<i>) so the server can parse without JS dependency.
//
// CATALOG PICKER: when the parent page passes `catalogItems`, we
// render a dropdown that pre-fills a new line with the description,
// category, and amount from the chosen catalog item (a product or a
// tuition grid). Operators no longer need to memorize prices or
// re-type product names — just pick from the list. Every field
// remains editable after selection so one-offs still work.

import { useMemo, useState } from 'react';
import { Plus, Trash2, ShoppingBag } from 'lucide-react';

interface Line {
  uid: number;     // local-only React key
  description: string;
  quantity: string;
  unit_amount: string;
  category: string;   // optional — drives discount applies_to_categories
}

// A pickable catalog item — either a product or a tuition grid, etc.
// Each adds a single prefilled line when chosen.
export interface CatalogItem {
  id: string;
  group: 'product' | 'tuition' | 'fee';
  label: string;                  // shown in the dropdown
  description: string;            // copied to the line's Description
  unit_amount_cents: number;      // copied to Unit $ (display in dollars)
  category: string;               // copied to Category column
  hint?: string;                  // optional <option> title attribute
}

// Common category values that discount_policies typically target.
// Operators can also type a custom value.
const COMMON_CATEGORIES = [
  '',
  'tuition',
  'enrollment_deposit',
  'trip',
  'before_care',
  'after_care',
  'fee',
  'other',
];

let _uid = 1;
function newLine(): Line {
  return { uid: _uid++, description: '', quantity: '1', unit_amount: '', category: '' };
}

function lineFromCatalog(item: CatalogItem): Line {
  return {
    uid: _uid++,
    description: item.description,
    quantity: '1',
    unit_amount: (item.unit_amount_cents / 100).toFixed(2),
    category: item.category,
  };
}

export function LineItemsEditor({
  catalogItems = [],
}: {
  catalogItems?: CatalogItem[];
} = {}) {
  const [lines, setLines] = useState<Line[]>([newLine()]);
  const [pickerValue, setPickerValue] = useState('');

  // Group catalog items by group for the dropdown. Stable order: tuition
  // first (most-used for invoices), then products, then misc fees.
  const grouped = useMemo(() => {
    const tuition = catalogItems.filter((c) => c.group === 'tuition');
    const products = catalogItems.filter((c) => c.group === 'product');
    const fees = catalogItems.filter((c) => c.group === 'fee');
    return { tuition, products, fees };
  }, [catalogItems]);

  function addLine() {
    setLines([...lines, newLine()]);
  }
  function removeLine(uid: number) {
    if (lines.length === 1) return;
    setLines(lines.filter((l) => l.uid !== uid));
  }
  function patch(uid: number, patch: Partial<Line>) {
    setLines(lines.map((l) => (l.uid === uid ? { ...l, ...patch } : l)));
  }

  // Catalog-picker handler: when a real value is chosen, look it up,
  // create a new line from it, and reset the dropdown to the
  // placeholder so the operator can pick another one immediately.
  function pickFromCatalog(value: string) {
    setPickerValue(value);
    if (!value) return;
    const item = catalogItems.find((c) => c.id === value);
    if (!item) return;
    // If the current state is a single blank line, replace it instead of
    // adding to it — that's almost always what the operator means.
    const onlyHasOneEmpty =
      lines.length === 1 &&
      !lines[0].description.trim() &&
      !lines[0].unit_amount.trim();
    const nextLine = lineFromCatalog(item);
    setLines(onlyHasOneEmpty ? [nextLine] : [...lines, nextLine]);
    // Reset the picker so the same item can be chosen again to add a
    // second copy without first switching to something else.
    setPickerValue('');
  }

  const subtotal = useMemo(() => {
    let cents = 0;
    for (const l of lines) {
      const q = parseInt(l.quantity, 10);
      const u = parseFloat(l.unit_amount);
      if (Number.isFinite(q) && Number.isFinite(u) && q > 0 && u > 0) {
        cents += Math.round(u * 100) * q;
      }
    }
    return cents;
  }, [lines]);

  return (
    <div className="space-y-2">
      {/* Catalog picker — only shows when items are available */}
      {catalogItems.length > 0 ? (
        <div className="flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50/40 px-3 py-2">
          <ShoppingBag className="h-4 w-4 text-blue-700 shrink-0" />
          <label className="flex-1 flex items-center gap-2 text-sm">
            <span className="text-xs font-medium text-blue-900 whitespace-nowrap">Add from catalog:</span>
            <select
              value={pickerValue}
              onChange={(e) => pickFromCatalog(e.target.value)}
              className="flex-1 rounded border border-blue-300 bg-white px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-200"
            >
              <option value="">— pick a product or tuition program —</option>
              {grouped.tuition.length > 0 ? (
                <optgroup label="Tuition programs">
                  {grouped.tuition.map((c) => (
                    <option key={c.id} value={c.id} title={c.hint}>{c.label}</option>
                  ))}
                </optgroup>
              ) : null}
              {grouped.products.length > 0 ? (
                <optgroup label="Products">
                  {grouped.products.map((c) => (
                    <option key={c.id} value={c.id} title={c.hint}>{c.label}</option>
                  ))}
                </optgroup>
              ) : null}
              {grouped.fees.length > 0 ? (
                <optgroup label="Fees">
                  {grouped.fees.map((c) => (
                    <option key={c.id} value={c.id} title={c.hint}>{c.label}</option>
                  ))}
                </optgroup>
              ) : null}
            </select>
          </label>
          <span className="text-[11px] text-blue-700 whitespace-nowrap">
            or add a custom line below
          </span>
        </div>
      ) : null}

      <table className="w-full text-sm">
        <thead className="text-left text-[10px] uppercase tracking-wide text-zinc-500">
          <tr>
            <th className="px-1 pb-1">Description</th>
            <th className="px-1 pb-1 w-32">Category</th>
            <th className="px-1 pb-1 text-right w-16">Qty</th>
            <th className="px-1 pb-1 text-right w-24">Unit $</th>
            <th className="px-1 pb-1 text-right w-24">Total</th>
            <th className="px-1 pb-1 w-8"></th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => {
            const q = parseInt(l.quantity, 10);
            const u = parseFloat(l.unit_amount);
            const lineTotal = Number.isFinite(q) && Number.isFinite(u) ? q * u : 0;
            return (
              <tr key={l.uid}>
                <td className="pr-1 py-1">
                  <input
                    type="text"
                    name={`line_description_${i}`}
                    value={l.description}
                    onChange={(e) => patch(l.uid, { description: e.target.value })}
                    placeholder="e.g. August Tuition — Charlotte"
                    className="w-full rounded border border-zinc-300 px-2 py-1 text-sm"
                  />
                </td>
                <td className="px-1 py-1">
                  <input
                    type="text"
                    name={`line_category_${i}`}
                    value={l.category}
                    onChange={(e) => patch(l.uid, { category: e.target.value })}
                    placeholder="tuition"
                    list={`category-options-${l.uid}`}
                    className="w-full rounded border border-zinc-300 px-1 py-1 text-xs"
                    title="Drives which discount policies can target this line (e.g. a sibling discount that applies_to_categories=['tuition'])"
                  />
                  <datalist id={`category-options-${l.uid}`}>
                    {COMMON_CATEGORIES.filter(Boolean).map((c) => (
                      <option key={c} value={c} />
                    ))}
                  </datalist>
                </td>
                <td className="px-1 py-1">
                  <input
                    type="number" min="1" step="1"
                    name={`line_quantity_${i}`}
                    value={l.quantity}
                    onChange={(e) => patch(l.uid, { quantity: e.target.value })}
                    className="w-full rounded border border-zinc-300 px-1 py-1 text-sm text-right"
                  />
                </td>
                <td className="px-1 py-1">
                  <input
                    type="number" min="0" step="0.01"
                    name={`line_unit_amount_${i}`}
                    value={l.unit_amount}
                    onChange={(e) => patch(l.uid, { unit_amount: e.target.value })}
                    placeholder="0.00"
                    className="w-full rounded border border-zinc-300 px-1 py-1 text-sm text-right"
                  />
                </td>
                <td className="px-1 py-1 text-right font-mono text-xs text-zinc-700">
                  ${lineTotal.toFixed(2)}
                </td>
                <td className="px-1 py-1 text-center">
                  <button
                    type="button"
                    onClick={() => removeLine(l.uid)}
                    disabled={lines.length === 1}
                    className="rounded p-1 text-zinc-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-30"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={addLine}
          className="inline-flex items-center gap-1 rounded border border-emerald-300 bg-white px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50"
        >
          <Plus className="h-3 w-3" /> Add custom line
        </button>
        <div className="text-sm">
          <span className="text-zinc-500">Subtotal: </span>
          <span className="font-mono font-semibold">${(subtotal / 100).toFixed(2)}</span>
        </div>
      </div>
    </div>
  );
}
