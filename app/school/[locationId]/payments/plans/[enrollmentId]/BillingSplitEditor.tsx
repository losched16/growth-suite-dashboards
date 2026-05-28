'use client';

// BillingSplitEditor — manages the per-enrollment billing split.
//
// Modes:
//   Joint:    one invoice per installment to the whole family (default).
//   Split:    one invoice per (installment × parent), each scoped to
//             that parent's share. Each parent has their own
//             responsibility, autopay, payment-method, and the parent
//             portal filters by responsible_parent_id so co-parents
//             never see each other's bills.
//
// Presets (50/50, 70/30, 100/0) and a custom mode where the operator
// types percentages directly. Validation: sum must be exactly 100%.
// The save button is disabled until the split is valid.
//
// Server-side validation is the canonical check (see
// /api/school/billing-shares/save and the DB trigger on
// enrollment_billing_shares) — client-side is just for UX.

import { useMemo, useState } from 'react';
import { Users, AlertCircle, Percent, Check } from 'lucide-react';

interface ParentRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  is_primary: boolean;
  existing_share_bp: number;     // 0 if not currently in the split
}

export function BillingSplitEditor({
  enrollmentId,
  returnTo,
  parents,
  isCurrentlySplit,
}: {
  enrollmentId: string;
  returnTo: string;
  parents: ParentRow[];
  isCurrentlySplit: boolean;
}) {
  // Initial shares: existing split values, or 100% to the primary parent
  // (matches the implicit-joint state — flipping to "split" without
  // touching anything keeps the primary as sole payer).
  const seed = (() => {
    if (isCurrentlySplit) {
      const map: Record<string, number> = {};
      for (const p of parents) map[p.id] = p.existing_share_bp;
      return map;
    }
    const primary = parents.find((p) => p.is_primary) ?? parents[0];
    const map: Record<string, number> = {};
    for (const p of parents) map[p.id] = p.id === primary?.id ? 10000 : 0;
    return map;
  })();

  const [mode, setMode] = useState<'joint' | 'split'>(isCurrentlySplit ? 'split' : 'joint');
  const [shares, setShares] = useState<Record<string, number>>(seed);

  const totalBp = useMemo(() => {
    return Object.values(shares).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  }, [shares]);
  const sumOk = totalBp === 10000;

  // Format a basis-point value as a percent string for the input box.
  const fmtPercent = (bp: number): string => {
    if (bp % 100 === 0) return String(bp / 100);
    return (bp / 100).toFixed(2);
  };

  const parsePercent = (raw: string): number => {
    const n = Number(raw.replace(/[^\d.]/g, ''));
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(10000, Math.round(n * 100)));
  };

  const applyPreset = (label: string) => {
    if (parents.length < 2) return;
    const [a, b] = parents;
    const next: Record<string, number> = {};
    for (const p of parents) next[p.id] = 0;
    if (label === '50/50') { next[a.id] = 5000; next[b.id] = 5000; }
    else if (label === '60/40') { next[a.id] = 6000; next[b.id] = 4000; }
    else if (label === '70/30') { next[a.id] = 7000; next[b.id] = 3000; }
    setShares(next);
  };

  return (
    <section className="rounded-xl border-2 border-slate-200 bg-white p-5">
      <div className="flex items-start gap-3 mb-3">
        <Users className="h-5 w-5 text-blue-600 mt-0.5" />
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-semibold text-slate-900">Billing split</h3>
          <p className="text-xs text-slate-600 mt-0.5">
            For divorced / separated families: each parent gets their own invoice for their share. Each parent has independent autopay + payment methods, and they never see each other&rsquo;s billing in the parent portal.
          </p>
        </div>
        {isCurrentlySplit ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
            Split-billed
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
            Joint
          </span>
        )}
      </div>

      <form action="/api/school/billing-shares/save" method="POST" className="space-y-3">
        <input type="hidden" name="enrollment_id" value={enrollmentId} />
        <input type="hidden" name="return_to" value={returnTo} />
        <input type="hidden" name="mode" value={mode} />

        {/* Mode toggle */}
        <div className="inline-flex rounded-md border border-slate-200 bg-slate-50 p-0.5">
          <button
            type="button"
            onClick={() => setMode('joint')}
            className={`px-3 py-1.5 text-xs font-semibold rounded ${
              mode === 'joint' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            Joint (one invoice)
          </button>
          <button
            type="button"
            onClick={() => setMode('split')}
            className={`px-3 py-1.5 text-xs font-semibold rounded ${
              mode === 'split' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            Split between parents
          </button>
        </div>

        {mode === 'split' ? (
          parents.length < 2 ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 flex items-start gap-2">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>
                Only one active parent on file. Add a second parent to the family before splitting the billing.
              </span>
            </div>
          ) : (
            <>
              {/* Presets */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Presets:</span>
                {['50/50', '60/40', '70/30'].map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => applyPreset(p)}
                    className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    {p}
                  </button>
                ))}
              </div>

              {/* Per-parent rows */}
              <div className="space-y-2">
                {parents.map((p, idx) => {
                  const name = `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() || `Parent #${idx + 1}`;
                  return (
                    <div key={p.id} className="grid grid-cols-[1fr_auto] gap-3 items-center rounded-md border border-slate-200 bg-slate-50/30 px-3 py-2">
                      <div>
                        <div className="text-sm font-medium text-slate-900">{name}</div>
                        <div className="text-[11px] text-slate-500 font-mono truncate">{p.email ?? '(no email)'}</div>
                      </div>
                      <div className="flex items-center gap-1">
                        <input
                          type="number"
                          min={0}
                          max={100}
                          step={0.01}
                          value={fmtPercent(shares[p.id] ?? 0)}
                          onChange={(e) => setShares({ ...shares, [p.id]: parsePercent(e.target.value) })}
                          className="w-20 rounded border border-slate-300 bg-white px-2 py-1 text-right text-sm tabular-nums focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-200"
                        />
                        <Percent className="h-3.5 w-3.5 text-slate-400" />
                        {/* Hidden field with bp value — what the API reads. */}
                        <input type="hidden" name={`share_bp_${p.id}`} value={shares[p.id] ?? 0} />
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Sum readout */}
              <div className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm ${
                sumOk
                  ? 'bg-emerald-50 border border-emerald-200 text-emerald-900'
                  : 'bg-rose-50 border border-rose-200 text-rose-900'
              }`}>
                {sumOk ? <Check className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
                <span className="font-semibold">Total: {(totalBp / 100).toFixed(totalBp % 100 === 0 ? 0 : 2)}%</span>
                {!sumOk ? (
                  <span className="text-xs ml-1">Must equal exactly 100% before saving.</span>
                ) : null}
              </div>
            </>
          )
        ) : (
          <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
            Joint mode is the default. One invoice per installment is sent to the family — the primary parent is the responsible party in the portal. Click <strong>Split between parents</strong> above to set up co-parent billing.
          </div>
        )}

        <div className="flex items-center gap-2 pt-2 border-t border-slate-100">
          <button
            type="submit"
            disabled={mode === 'split' && (!sumOk || parents.length < 2)}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {mode === 'joint' && isCurrentlySplit
              ? 'Revert to joint billing'
              : mode === 'split'
              ? 'Save split'
              : 'Save'}
          </button>
          <p className="text-[11px] text-slate-500">
            Applies to <strong>future invoice generation</strong>. Existing draft/open invoices for this plan are NOT retroactively split — regenerate the plan from the Reschedule action if you need to.
          </p>
        </div>
      </form>
    </section>
  );
}
