// Discounts tab — list, inline create, and deactivate.
//
// All actions POST to /api/admin/schools/{schoolId}/payments/discounts.
// The endpoint's default redirect target (/admin/{schoolId}/payments)
// is intercepted by the proxy and bounced back to /school/.../payments
// so school-iframe users land back in-context.
//
// Three kinds of discount supported:
//   - auto             auto-applied to every invoice that matches the
//                      `applies_to_categories` filter (e.g. sibling
//                      discount on tuition).
//   - code             parent enters a redemption code at checkout.
//   - financial_aid    award attached to a specific FA application.
//
// Each kind has slightly different required fields, surfaced via the
// kind toggle in the create form.

import { Plus, Power } from 'lucide-react';
import { query } from '@/lib/db';

export async function PaymentsHubDiscounts({
  schoolId, locationId,
}: { schoolId: string; locationId: string }) {
  const { rows } = await query<{
    id: string;
    kind: 'auto' | 'code' | 'financial_aid';
    display_name: string;
    percentage_basis_points: number;
    amount_cents: number;
    redemption_code: string | null;
    redemption_count: number;
    max_total_redemptions: number | null;
    applies_to_categories: string[];
    is_active: boolean;
  }>(
    `SELECT id, kind, display_name, percentage_basis_points, amount_cents,
            redemption_code, redemption_count, max_total_redemptions,
            applies_to_categories, is_active
       FROM discount_policies WHERE school_id = $1
       ORDER BY is_active DESC, kind, display_name`,
    [schoolId],
  );

  const apiUrl = `/api/admin/schools/${schoolId}/payments/discounts`;
  const returnTo = `/school/${locationId}/payments?tab=discounts`;

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Discounts</h2>
          <p className="text-sm text-slate-500">
            Auto-apply rules (sibling, early-bird), parent-redeemable codes, and financial-aid awards.
          </p>
        </div>
      </div>

      {/* ── Add new discount ──────────────────────────────────────── */}
      <details className="rounded-lg border-2 border-blue-200 bg-blue-50/30 overflow-hidden group">
        <summary className="cursor-pointer list-none px-4 py-3 flex items-center gap-2 text-sm font-semibold text-blue-900 hover:bg-blue-50">
          <Plus className="h-4 w-4" />
          Add a new discount
          <span className="text-[11px] font-normal text-blue-700 ml-1">— sibling discount, promo code, or one-off award</span>
        </summary>

        <form action={apiUrl} method="POST" className="px-4 pb-4 pt-2 space-y-3 border-t border-blue-100 bg-white">
          <input type="hidden" name="op" value="add" />
          {/* The discount API redirects back to /admin/{schoolId}/payments
              by default; the proxy bounces school-session users to the
              equivalent /school/{loc}/payments URL. No return_to needed. */}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Type" required>
              <select name="kind" required defaultValue="auto" className={inputCls}>
                <option value="auto">Auto-applied (e.g. sibling discount)</option>
                <option value="code">Promo code (parent enters at checkout)</option>
                <option value="financial_aid">Financial-aid award (one family)</option>
              </select>
            </Field>
            <Field label="Display name" required hint="What parents see on the invoice.">
              <input type="text" name="display_name" required maxLength={80} placeholder="e.g. Sibling Discount" className={inputCls} />
            </Field>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Percent off (%)" hint="Either this or flat $.">
              <input type="number" step="0.01" min="0" max="100" name="percentage_pct" placeholder="e.g. 10" className={inputCls} />
            </Field>
            <Field label="Flat amount off ($)" hint="Either this or %.">
              <input type="number" step="0.01" min="0" name="amount_dollars" placeholder="e.g. 250" className={inputCls} />
            </Field>
            <Field label="Cap on % discount ($)" hint="Optional ceiling for % discounts.">
              <input type="number" step="0.01" min="0" name="max_discount_dollars" placeholder="e.g. 1000" className={inputCls} />
            </Field>
          </div>

          <Field label="Applies to (comma-separated categories)" hint="Leave blank to apply to ALL line items. Common: tuition, tuition_addon, registration.">
            <input type="text" name="applies_to_categories" placeholder="e.g. tuition" className={inputCls} />
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Redemption code" hint="Required for 'Promo code' type. Parent types this at checkout. Uppercase only.">
              <input type="text" name="redemption_code" placeholder="e.g. EARLYBIRD2026" className={inputCls + ' uppercase font-mono'} />
            </Field>
            <Field label="Max total redemptions" hint="Optional. Auto-deactivates after this many uses.">
              <input type="number" min="1" name="max_total_redemptions" placeholder="e.g. 50" className={inputCls} />
            </Field>
          </div>

          <Field label="FA application ID (financial_aid only)" hint="UUID from financial_aid_applications when kind = financial_aid.">
            <input type="text" name="fa_application_id" placeholder="leave blank unless tying to a specific FA application" className={inputCls + ' font-mono text-xs'} />
          </Field>

          <details className="rounded border border-slate-200 bg-slate-50/40 px-3 py-2">
            <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-slate-600">
              Advanced — eligibility conditions (JSON)
            </summary>
            <div className="mt-2">
              <p className="text-[11px] text-slate-500 mb-1">
                Optional JSON object expressing eligibility rules (e.g. <code className="font-mono">{`{"min_students": 2}`}</code> for a 2+-kid sibling discount). Leave blank for no extra conditions.
              </p>
              <textarea name="conditions_json" rows={2} placeholder='{"min_students": 2}' className={inputCls + ' font-mono text-xs'} />
            </div>
          </details>

          <div className="flex items-center gap-2 pt-2">
            <button type="submit" className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
              Create discount
            </button>
            <p className="text-[11px] text-slate-500">
              Auto discounts apply to every matching invoice going forward. They don&rsquo;t re-issue invoices already generated.
            </p>
          </div>
        </form>
      </details>

      {/* ── Active + inactive policies ────────────────────────────── */}
      <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-100 text-left text-[10px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2.5 font-medium">Type</th>
              <th className="px-4 py-2.5 font-medium">Name</th>
              <th className="px-4 py-2.5 font-medium">Amount</th>
              <th className="px-4 py-2.5 font-medium">Applies to</th>
              <th className="px-4 py-2.5 font-medium text-right">Usage</th>
              <th className="px-4 py-2.5 font-medium text-center">Active</th>
              <th className="px-4 py-2.5 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 ? (
              <tr><td colSpan={7} className="p-10 text-center text-sm text-slate-500 italic">No discount policies yet. Click <strong>Add a new discount</strong> above to create your first one.</td></tr>
            ) : rows.map((d) => (
              <tr key={d.id} className="hover:bg-slate-50">
                <td className="px-4 py-2"><KindBadge kind={d.kind} /></td>
                <td className="px-4 py-2">
                  <div className="text-slate-900">{d.display_name}</div>
                  {d.redemption_code ? (
                    <div className="text-[10px] text-slate-500 font-mono">code: {d.redemption_code}</div>
                  ) : null}
                </td>
                <td className="px-4 py-2 font-mono text-xs">
                  {d.percentage_basis_points > 0
                    ? `${(d.percentage_basis_points / 100).toFixed(1)}%`
                    : `$${(d.amount_cents / 100).toFixed(2)}`}
                </td>
                <td className="px-4 py-2 text-xs text-slate-600">
                  {d.applies_to_categories.length > 0 ? d.applies_to_categories.join(', ') : 'all'}
                </td>
                <td className="px-4 py-2 text-right text-xs tabular-nums">
                  {d.redemption_count}
                  {d.max_total_redemptions ? <span className="text-slate-400"> / {d.max_total_redemptions}</span> : ''}
                </td>
                <td className="px-4 py-2 text-center">
                  {d.is_active ? <Pill bg="bg-emerald-100" fg="text-emerald-800">Active</Pill>
                               : <Pill bg="bg-slate-100" fg="text-slate-600">Inactive</Pill>}
                </td>
                <td className="px-4 py-2 text-right">
                  {d.is_active ? (
                    <form action={apiUrl} method="POST" className="inline">
                      <input type="hidden" name="op" value="delete" />
                      <input type="hidden" name="id" value={d.id} />
                      <button
                        type="submit"
                        className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-rose-50 hover:border-rose-300 hover:text-rose-700"
                        title="Deactivate — future invoices won't apply this discount. Past applications are preserved."
                      >
                        <Power className="h-3 w-3" /> Deactivate
                      </button>
                    </form>
                  ) : (
                    <span className="text-[10px] text-slate-400 italic">archived</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {void locationId}{void returnTo}
    </div>
  );
}

function KindBadge({ kind }: { kind: 'auto' | 'code' | 'financial_aid' }) {
  const cfg = kind === 'auto' ? { bg: 'bg-blue-100',   fg: 'text-blue-800',   label: 'Auto' }
            : kind === 'code' ? { bg: 'bg-violet-100', fg: 'text-violet-800', label: 'Code' }
                              : { bg: 'bg-amber-100',  fg: 'text-amber-800',  label: 'FA' };
  return <Pill bg={cfg.bg} fg={cfg.fg}>{cfg.label}</Pill>;
}

function Pill({ children, bg, fg }: { children: React.ReactNode; bg: string; fg: string }) {
  return <span className={`inline-block rounded ${bg} px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${fg}`}>{children}</span>;
}

// ── Form input helpers ──────────────────────────────────────────────
const inputCls =
  'mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-200';

function Field({
  label, required, hint, children,
}: { label: string; required?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-slate-700">
        {label} {required ? <span className="text-rose-600">*</span> : null}
      </span>
      {hint ? <span className="block text-[10px] text-slate-500 mt-0.5">{hint}</span> : null}
      {children}
    </label>
  );
}
