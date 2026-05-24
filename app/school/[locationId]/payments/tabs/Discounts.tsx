// Discounts tab — list of discount policies, simple add CTA.

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

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Discounts</h2>
          <p className="text-sm text-slate-500">
            Auto-apply rules (sibling, early-bird), parent-redeemable codes, and financial-aid awards.
          </p>
        </div>
        {/* "Manage discounts" used to deep-link to /admin/.../payments#discounts
            which escapes the iframe. Hidden for now — the discount editor
            UI is admin-only and lives in the operator console; we'll
            surface a school-scoped editor in a follow-up if needed. */}
      </div>

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
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 ? (
              <tr><td colSpan={6} className="p-10 text-center text-sm text-slate-500 italic">No discount policies yet.</td></tr>
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
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {void locationId}
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
