'use client';

// Inline line-item editor. Adds/removes rows client-side; submits as
// indexed form fields (line_description_<i>, line_quantity_<i>,
// line_unit_amount_<i>) so the server can parse without JS dependency.

import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';

interface Line {
  uid: number;     // local-only React key
  description: string;
  quantity: string;
  unit_amount: string;
  category: string;   // optional — drives discount applies_to_categories
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

export function LineItemsEditor() {
  const [lines, setLines] = useState<Line[]>([newLine()]);

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
          <Plus className="h-3 w-3" /> Add line item
        </button>
        <div className="text-sm">
          <span className="text-zinc-500">Subtotal: </span>
          <span className="font-mono font-semibold">${(subtotal / 100).toFixed(2)}</span>
        </div>
      </div>
    </div>
  );
}
