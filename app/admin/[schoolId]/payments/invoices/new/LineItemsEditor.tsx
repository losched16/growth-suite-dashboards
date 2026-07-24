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
//
// DISCOUNTS: when the parent page passes `discountPolicies` (the school's
// Discounts section), an "Add discount" dropdown lets the operator drop a
// defined discount — or a one-off custom credit — onto the invoice as a
// negative line item. Percentage policies are computed live against the
// positive subtotal; the server re-resolves policy amounts authoritatively
// so a stale/tampered amount can't stick.

import { useMemo, useState } from 'react';
import { Plus, Trash2, ShoppingBag, BadgePercent } from 'lucide-react';

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

// A discount defined in the school's Discounts section.
export interface DiscountPolicyOpt {
  id: string;
  display_name: string;
  kind: string;                       // 'auto' | 'code' | 'financial_aid'
  percentage_basis_points: number;    // >0 = percentage discount
  amount_cents: number;               // >0 = fixed-dollar discount
  max_discount_cents: number | null;  // cap for percentage discounts
}

interface DiscountRow {
  uid: number;
  policyId: string;      // '' = custom one-off
  description: string;
  bps: number;           // >0 → percentage (computed live), else fixed
  amount: string;        // dollars — used for custom / fixed-dollar rows
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

function fmtCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function LineItemsEditor({
  catalogItems = [],
  discountPolicies = [],
}: {
  catalogItems?: CatalogItem[];
  discountPolicies?: DiscountPolicyOpt[];
} = {}) {
  const [lines, setLines] = useState<Line[]>([newLine()]);
  const [pickerValue, setPickerValue] = useState('');
  const [discounts, setDiscounts] = useState<DiscountRow[]>([]);
  const [discountPick, setDiscountPick] = useState('');

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

  // Effective discount cents for a row: percentage rows compute live off
  // the current positive subtotal (capped); fixed/custom rows use the
  // typed dollar amount. Never exceed the subtotal.
  // Mirrors the server: a picked policy is authoritative (% off the positive
  // subtotal, capped, or its fixed amount); a custom row uses the typed
  // dollars. Never exceeds the subtotal.
  function discountCents(d: DiscountRow, policy?: DiscountPolicyOpt): number {
    let cents: number;
    if (policy) {
      cents = policy.percentage_basis_points > 0
        ? Math.round((subtotal * policy.percentage_basis_points) / 10000)
        : policy.amount_cents;
      if (policy.max_discount_cents && policy.max_discount_cents > 0) {
        cents = Math.min(cents, policy.max_discount_cents);
      }
    } else {
      const dollars = parseFloat(d.amount);
      cents = Number.isFinite(dollars) && dollars > 0 ? Math.round(dollars * 100) : 0;
    }
    return Math.min(cents, subtotal);
  }

  const discountTotal = useMemo(() => {
    return discounts.reduce((acc, d) => {
      const policy = discountPolicies.find((p) => p.id === d.policyId);
      return acc + discountCents(d, policy);
    }, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discounts, subtotal, discountPolicies]);

  const netTotal = Math.max(0, subtotal - discountTotal);

  function addDiscount(value: string) {
    setDiscountPick('');
    if (!value) return;
    if (value === '__custom__') {
      setDiscounts((prev) => [...prev, { uid: _uid++, policyId: '', description: '', bps: 0, amount: '' }]);
      return;
    }
    const p = discountPolicies.find((x) => x.id === value);
    if (!p) return;
    const isPct = p.percentage_basis_points > 0;
    setDiscounts((prev) => [
      ...prev,
      {
        uid: _uid++,
        policyId: p.id,
        description: isPct ? `${p.display_name} (${(p.percentage_basis_points / 100).toFixed(0)}%)` : p.display_name,
        bps: isPct ? p.percentage_basis_points : 0,
        amount: isPct ? '' : (p.amount_cents / 100).toFixed(2),
      },
    ]);
  }
  function removeDiscount(uid: number) {
    setDiscounts(discounts.filter((d) => d.uid !== uid));
  }
  function patchDiscount(uid: number, p: Partial<DiscountRow>) {
    setDiscounts(discounts.map((d) => (d.uid === uid ? { ...d, ...p } : d)));
  }

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

      {/* ── Discounts as line items ─────────────────────────────────── */}
      <div className="mt-2 rounded-md border border-emerald-200 bg-emerald-50/30 p-3 space-y-2">
        <div className="flex items-center gap-2">
          <BadgePercent className="h-4 w-4 text-emerald-700 shrink-0" />
          <label className="flex-1 flex items-center gap-2 text-sm">
            <span className="text-xs font-medium text-emerald-900 whitespace-nowrap">Add discount:</span>
            <select
              value={discountPick}
              onChange={(e) => addDiscount(e.target.value)}
              className="flex-1 rounded border border-emerald-300 bg-white px-2 py-1.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-200"
            >
              <option value="">— pick a discount or add a custom one —</option>
              {discountPolicies.length > 0 ? (
                <optgroup label="From your Discounts section">
                  {discountPolicies.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.display_name}
                      {p.percentage_basis_points > 0
                        ? ` — ${(p.percentage_basis_points / 100).toFixed(0)}%`
                        : p.amount_cents > 0 ? ` — ${fmtCents(p.amount_cents)}` : ''}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              <optgroup label="One-off">
                <option value="__custom__">Custom discount…</option>
              </optgroup>
            </select>
          </label>
        </div>

        {discounts.length === 0 ? (
          <p className="text-[11px] text-emerald-800/70 italic">
            No manual discounts. Auto-apply policies (sibling, early-bird) still evaluate automatically.
          </p>
        ) : (
          <div className="space-y-1.5">
            {discounts.map((d, i) => {
              const policy = discountPolicies.find((p) => p.id === d.policyId);
              const eff = discountCents(d, policy);
              return (
                <div key={d.uid} className="flex items-center gap-2">
                  <input
                    type="text"
                    name={`discount_description_${i}`}
                    value={d.description}
                    onChange={(e) => patchDiscount(d.uid, { description: e.target.value })}
                    placeholder="Discount label (e.g. Staff discount)"
                    className="flex-1 rounded border border-emerald-300 px-2 py-1 text-sm"
                  />
                  {/* Policy rows show the server-authoritative amount
                      (read-only); custom one-offs are editable dollars. */}
                  {d.policyId ? (
                    <span className="w-24 text-right font-mono text-sm text-emerald-800">−{fmtCents(eff)}</span>
                  ) : (
                    <div className="flex items-center gap-1">
                      <span className="text-emerald-700 text-sm">−$</span>
                      <input
                        type="number" min="0" step="0.01"
                        name={`discount_amount_${i}`}
                        value={d.amount}
                        onChange={(e) => patchDiscount(d.uid, { amount: e.target.value })}
                        placeholder="0.00"
                        className="w-24 rounded border border-emerald-300 px-1 py-1 text-sm text-right"
                      />
                    </div>
                  )}
                  {/* Carry the policy id — the server re-resolves the amount
                      authoritatively. For policy rows we post the computed
                      amount too (no-JS fallback / display), but it's ignored
                      server-side when a policy id is present. */}
                  <input type="hidden" name={`discount_policy_id_${i}`} value={d.policyId} />
                  {d.policyId ? (
                    <input type="hidden" name={`discount_amount_${i}`} value={(eff / 100).toFixed(2)} />
                  ) : null}
                  <button
                    type="button"
                    onClick={() => removeDiscount(d.uid)}
                    className="rounded p-1 text-zinc-400 hover:bg-rose-50 hover:text-rose-600"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {discountTotal > 0 ? (
          <div className="flex items-center justify-end gap-4 border-t border-emerald-200 pt-2 text-sm">
            <span className="text-emerald-800">Discounts: <span className="font-mono">−{fmtCents(discountTotal)}</span></span>
            <span className="text-slate-900 font-semibold">Net: <span className="font-mono">{fmtCents(netTotal)}</span></span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
