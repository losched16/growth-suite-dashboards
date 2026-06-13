'use client';

// Simple "set up a family's tuition" form. Pick an existing family +
// student, pick the grade (which is just picking the tuition grid — the
// price comes from the grid, so tuition is "calculated by grade"),
// optionally add add-ons, and optionally pre-select a payment frequency.
//
//   • Frequency chosen  → invoices generate now; the parent sees the
//     plan LOCKED in their portal (can't change without calling the school).
//   • Frequency left as "Let the parent choose" → the enrollment is
//     recorded with the contracted tuition but NO plan; the parent picks
//     their frequency in their enrollment agreement, which locks it in.
//
// Posts to /api/admin/schools/{schoolId}/payments/enrollments (op=create).

import { useMemo, useState } from 'react';
import { GraduationCap, CalendarClock, Info } from 'lucide-react';

export interface FamilyOpt { id: string; label: string }
export interface StudentOpt { id: string; family_id: string; name: string; program_name: string | null }
export interface GridOpt {
  id: string;
  grade_level: string;
  display_name: string;
  annual_tuition_cents: number;
  addons: Array<{ key: string; label: string; amount_cents: number; required?: boolean }>;
}
export interface PlanOpt {
  id: string;
  display_name: string;
  installment_count: number;
  discount_basis_points: number;
}

function fmt(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

export function EnrollmentSetupForm({
  schoolId, academicYear, returnTo, billingActive,
  families, studentsByFamily, grids, plans,
}: {
  schoolId: string;
  academicYear: string;
  returnTo: string;
  billingActive: boolean;
  families: FamilyOpt[];
  studentsByFamily: Record<string, StudentOpt[]>;
  grids: GridOpt[];
  plans: PlanOpt[];
}) {
  const [familyId, setFamilyId] = useState('');
  const [studentId, setStudentId] = useState('');
  const [gridId, setGridId] = useState('');
  const [planId, setPlanId] = useState(''); // '' = let the parent choose
  const [addonKeys, setAddonKeys] = useState<Set<string>>(new Set());

  const famStudents = familyId ? (studentsByFamily[familyId] ?? []) : [];

  // Grids grouped by grade level so the operator picks a grade, then the
  // specific schedule under it. Tuition is whatever that grid carries.
  const gridsByGrade = useMemo(() => {
    const m = new Map<string, GridOpt[]>();
    for (const g of grids) {
      const list = m.get(g.grade_level) ?? [];
      list.push(g);
      m.set(g.grade_level, list);
    }
    return [...m.entries()];
  }, [grids]);

  const grid = grids.find((g) => g.id === gridId) ?? null;
  const plan = plans.find((p) => p.id === planId) ?? null;

  // Live preview math — mirrors the server (grid − plan discount + addons).
  const addonTotal = grid
    ? grid.addons.filter((a) => addonKeys.has(a.key) || a.required).reduce((s, a) => s + a.amount_cents, 0)
    : 0;
  const baseTuition = grid?.annual_tuition_cents ?? 0;
  const discount = plan ? Math.round(baseTuition * plan.discount_basis_points / 10000) : 0;
  const annualTotal = baseTuition - discount + addonTotal;
  const perInstallment = plan && plan.installment_count > 0
    ? Math.round(annualTotal / plan.installment_count)
    : annualTotal;

  function toggleAddon(key: string) {
    setAddonKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  const canSubmit = familyId && studentId && gridId;

  return (
    <form
      action={`/api/admin/schools/${schoolId}/payments/enrollments`}
      method="POST"
      className="rounded-xl border border-slate-200 bg-white p-5 space-y-5"
    >
      <input type="hidden" name="op" value="create" />
      <input type="hidden" name="return_to" value={returnTo} />
      <input type="hidden" name="academic_year" value={academicYear} />

      {/* Family + student */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className={labelCls}>Family *</span>
          <select
            name="family_id" required value={familyId}
            onChange={(e) => { setFamilyId(e.target.value); setStudentId(''); }}
            className={inputCls}
          >
            <option value="">— select a family —</option>
            {families.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </label>
        <label className="block">
          <span className={labelCls}>Student *</span>
          <select
            name="student_id" required value={studentId}
            onChange={(e) => setStudentId(e.target.value)}
            disabled={!familyId}
            className={inputCls}
          >
            <option value="">{familyId ? '— select a student —' : '— pick a family first —'}</option>
            {famStudents.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}{s.program_name ? ` · ${s.program_name}` : ''}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Grade → tuition */}
      <div className="border-t border-slate-100 pt-4">
        <div className="flex items-center gap-1.5 mb-1.5">
          <GraduationCap className="h-4 w-4 text-slate-500" />
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">Grade &amp; tuition *</h3>
        </div>
        <p className="text-[11px] text-slate-500 mb-2">
          Pick the program/grade. Tuition is set automatically from your rate card.
        </p>
        {grids.length === 0 ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            No active tuition grids for {academicYear}. Add them under <strong>Payments → Grids</strong> first.
          </div>
        ) : (
          <select
            name="tuition_grid_id" required value={gridId}
            onChange={(e) => { setGridId(e.target.value); setAddonKeys(new Set()); }}
            className={inputCls}
          >
            <option value="">— select grade / program —</option>
            {gridsByGrade.map(([grade, list]) => (
              <optgroup key={grade} label={grade}>
                {list.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.display_name} — {fmt(g.annual_tuition_cents)}/yr
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        )}

        {/* Add-ons (only if this grid has any) */}
        {grid && grid.addons.length > 0 ? (
          <div className="mt-3 space-y-1.5">
            <span className={labelCls}>Add-ons</span>
            {grid.addons.map((a) => (
              <label key={a.key} className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox" name="addon_keys" value={a.key}
                  checked={addonKeys.has(a.key) || !!a.required}
                  disabled={!!a.required}
                  onChange={() => toggleAddon(a.key)}
                  className="h-4 w-4 rounded border-slate-300"
                />
                <span>{a.label} <span className="text-slate-500">+{fmt(a.amount_cents)}</span>{a.required ? <span className="ml-1 text-[10px] uppercase text-slate-400">required</span> : null}</span>
              </label>
            ))}
          </div>
        ) : null}
      </div>

      {/* Payment frequency (optional) */}
      <div className="border-t border-slate-100 pt-4">
        <div className="flex items-center gap-1.5 mb-1.5">
          <CalendarClock className="h-4 w-4 text-slate-500" />
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">Payment frequency</h3>
        </div>
        <select
          name="payment_plan_id" value={planId}
          onChange={(e) => setPlanId(e.target.value)}
          className={inputCls}
        >
          <option value="">Let the parent choose (recommended)</option>
          {plans.map((p) => (
            <option key={p.id} value={p.id}>
              {p.display_name} — {p.installment_count === 1 ? '1 payment' : `${p.installment_count} payments`}
              {p.discount_basis_points > 0 ? ` (${(p.discount_basis_points / 100).toFixed(0)}% off)` : ''}
            </option>
          ))}
        </select>
        <p className="mt-1 flex items-start gap-1 text-[11px] text-slate-500">
          <Info className="h-3 w-3 mt-0.5 shrink-0" />
          {planId
            ? 'You’re setting the plan for them. The parent will see it locked in and must contact the school to change it.'
            : 'The parent picks Annual / Semi-Annual / Monthly in their enrollment agreement — then it locks in.'}
        </p>
      </div>

      {/* Internal note */}
      <label className="block">
        <span className={labelCls}>Internal note (operator-only)</span>
        <input type="text" name="internal_note" placeholder="e.g. starts mid-year, prorate" className={inputCls} />
      </label>

      {/* Live preview */}
      {grid ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-4">
          <div className="flex items-baseline justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-emerald-900">Annual tuition</span>
            <span className="text-2xl font-semibold tabular-nums text-emerald-900">{fmt(annualTotal)}</span>
          </div>
          <div className="mt-1 space-y-0.5 text-xs text-emerald-800">
            <div className="flex justify-between"><span>Base ({grid.display_name})</span><span className="tabular-nums">{fmt(baseTuition)}</span></div>
            {addonTotal > 0 ? <div className="flex justify-between"><span>Add-ons</span><span className="tabular-nums">+{fmt(addonTotal)}</span></div> : null}
            {discount > 0 ? <div className="flex justify-between"><span>{plan?.display_name} discount</span><span className="tabular-nums">−{fmt(discount)}</span></div> : null}
            {plan ? (
              <div className="flex justify-between border-t border-emerald-200 pt-0.5 font-semibold">
                <span>{plan.installment_count === 1 ? 'One payment' : `${plan.installment_count} payments of`}</span>
                <span className="tabular-nums">{fmt(perInstallment)}{plan.installment_count > 1 ? ' ea.' : ''}</span>
              </div>
            ) : (
              <div className="border-t border-emerald-200 pt-0.5 italic">Parent picks the payment schedule.</div>
            )}
          </div>
        </div>
      ) : null}

      {!billingActive ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <strong>Test mode is on.</strong> Invoices will be created as drafts (parents won&rsquo;t be billed
          and won&rsquo;t see them) until you flip <strong>Go live</strong> in Payments settings.
        </div>
      ) : null}

      <div className="flex items-center gap-2 pt-1">
        <button
          type="submit" disabled={!canSubmit}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
        >
          Create enrollment
        </button>
        <a href={returnTo} className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">
          Cancel
        </a>
      </div>
    </form>
  );
}

const inputCls =
  'mt-0.5 block w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none';
const labelCls = 'text-[11px] font-medium uppercase tracking-wide text-slate-600';
