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
import { GraduationCap, CalendarClock, Info, PlusCircle, Trash2 } from 'lucide-react';
import type { AddonCatalog } from '@/lib/billing/addon-catalog';

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

// One add-on row on the enrollment: a rate-card pick (category + optionId)
// OR a custom one-off (category='' with a typed label + signed amount).
// Multiple rows of any kind are allowed.
interface AddonRow {
  uid: number;
  category: '' | 'extended_care' | 'deposit' | 'development_fee';
  optionId: string;
  label: string;   // editable for custom rows; catalog label (display) otherwise
  amount: string;  // editable dollars for custom rows (signed: negative = credit)
}
let _addonUid = 1;

function fmt(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

export function EnrollmentSetupForm({
  schoolId, academicYear, returnTo, billingActive,
  families, studentsByFamily, grids, plans, addonCatalog, defaultFamilyId,
}: {
  schoolId: string;
  academicYear: string;
  returnTo: string;
  billingActive: boolean;
  families: FamilyOpt[];
  studentsByFamily: Record<string, StudentOpt[]>;
  grids: GridOpt[];
  plans: PlanOpt[];
  // Reusable "rate card" of extended-care tiers + deposit + dev-fee options
  // the operator can add to this enrollment. Empty categories are hidden.
  addonCatalog: AddonCatalog;
  // Preselect this family (e.g. arriving from the "Set up plan" button on
  // the Tuition Plans tab's "awaiting plan setup" list).
  defaultFamilyId?: string;
}) {
  const [familyId, setFamilyId] = useState(defaultFamilyId ?? '');
  const [studentId, setStudentId] = useState('');
  const [gridId, setGridId] = useState('');
  const [planId, setPlanId] = useState(''); // '' = let the parent choose
  const [addonKeys, setAddonKeys] = useState<Set<string>>(new Set());
  // Add-ons on this enrollment — any mix of rate-card options + custom
  // one-offs, multiple allowed. Amounts are re-resolved server-side.
  const [addonRows, setAddonRows] = useState<AddonRow[]>([]);
  const [addonPick, setAddonPick] = useState('');
  // First tuition payment drafts on this date (school's choice) — anchors
  // the whole installment schedule. Default July 1 of the academic year.
  const defaultFirstDue = `${academicYear.split('-')[0]}-07-01`;
  const [firstDueDate, setFirstDueDate] = useState(defaultFirstDue);

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

  // Effective {label, cents} for an add-on row: catalog rows resolve from the
  // rate card; custom rows use the typed label + signed dollars. null = drop.
  // The server re-resolves the same way (authoritative for catalog picks).
  function rowEffective(r: AddonRow): { label: string; amount_cents: number } | null {
    if (r.category && r.optionId) {
      const opt = addonCatalog[r.category]?.find((o) => o.id === r.optionId);
      return opt ? { label: opt.label, amount_cents: opt.amount_cents } : null;
    }
    const label = r.label.trim();
    const dollars = parseFloat(r.amount);
    if (!label || !Number.isFinite(dollars) || dollars === 0) return null;
    return { label, amount_cents: Math.round(dollars * 100) };
  }
  const addonEffs = addonRows
    .map((r) => {
      const e = rowEffective(r);
      return e ? { uid: r.uid, label: e.label, amount_cents: e.amount_cents } : null;
    })
    .filter((x): x is { uid: number; label: string; amount_cents: number } => x !== null);
  const catalogAddonCents = addonEffs.reduce((s, o) => s + o.amount_cents, 0);

  const hasCatalog = addonCatalog.extended_care.length > 0
    || addonCatalog.deposit.length > 0
    || addonCatalog.development_fee.length > 0;

  function addAddon(value: string) {
    setAddonPick('');
    if (!value) return;
    if (value === '__custom__') {
      setAddonRows((prev) => [...prev, { uid: _addonUid++, category: '', optionId: '', label: '', amount: '' }]);
      return;
    }
    const sep = value.indexOf(':');
    const cat = value.slice(0, sep) as AddonRow['category'];
    const id = value.slice(sep + 1);
    const opt = cat ? addonCatalog[cat]?.find((o) => o.id === id) : null;
    if (!opt) return;
    setAddonRows((prev) => [...prev, {
      uid: _addonUid++, category: cat, optionId: id, label: opt.label, amount: (opt.amount_cents / 100).toFixed(2),
    }]);
  }
  function removeAddon(uid: number) { setAddonRows((prev) => prev.filter((r) => r.uid !== uid)); }
  function patchAddon(uid: number, p: Partial<AddonRow>) {
    setAddonRows((prev) => prev.map((r) => (r.uid === uid ? { ...r, ...p } : r)));
  }

  // Live preview math — mirrors the server (grid − plan discount + addons).
  const gridAddonTotal = grid
    ? grid.addons.filter((a) => addonKeys.has(a.key) || a.required).reduce((s, a) => s + a.amount_cents, 0)
    : 0;
  const addonTotal = gridAddonTotal + catalogAddonCents;
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

      {/* Add-ons — any mix of rate-card options + custom one-offs, multiple
          allowed. Rate-card picks are read-only (server-authoritative);
          custom rows are editable (signed: negative = a credit). */}
      <div className="border-t border-slate-100 pt-4">
        <div className="flex items-center gap-1.5 mb-1.5">
          <PlusCircle className="h-4 w-4 text-slate-500" />
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">Add-ons</h3>
        </div>
        <p className="text-[11px] text-slate-500 mb-2">
          {hasCatalog ? 'Pick from your rate card or add a custom one-off — ' : 'Add a custom one-off — '}
          as many as you need. Positive adds to tuition; a negative amount is a credit.
        </p>
        <select value={addonPick} onChange={(e) => addAddon(e.target.value)} className={inputCls}>
          <option value="">＋ Add an add-on…</option>
          {addonCatalog.extended_care.length > 0 ? (
            <optgroup label="Extended care">
              {addonCatalog.extended_care.map((o) => (
                <option key={o.id} value={`extended_care:${o.id}`}>{o.label} (+{fmt(o.amount_cents)})</option>
              ))}
            </optgroup>
          ) : null}
          {addonCatalog.deposit.length > 0 ? (
            <optgroup label="Deposit">
              {addonCatalog.deposit.map((o) => (
                <option key={o.id} value={`deposit:${o.id}`}>{o.label} (−{fmt(Math.abs(o.amount_cents))})</option>
              ))}
            </optgroup>
          ) : null}
          {addonCatalog.development_fee.length > 0 ? (
            <optgroup label="Development fee">
              {addonCatalog.development_fee.map((o) => (
                <option key={o.id} value={`development_fee:${o.id}`}>{o.label} (+{fmt(o.amount_cents)})</option>
              ))}
            </optgroup>
          ) : null}
          <optgroup label="One-off">
            <option value="__custom__">Custom add-on…</option>
          </optgroup>
        </select>

        {addonRows.length > 0 ? (
          <div className="mt-2 space-y-1.5">
            {addonRows.map((r, i) => {
              const eff = rowEffective(r);
              const isCustom = !r.category;
              return (
                <div key={r.uid} className="flex items-center gap-2">
                  {isCustom ? (
                    <input type="text" value={r.label} placeholder="Add-on label (e.g. Materials fee)"
                      onChange={(e) => patchAddon(r.uid, { label: e.target.value })}
                      className="flex-1 rounded border border-slate-300 px-2 py-1 text-sm" />
                  ) : (
                    <span className="flex-1 text-sm text-slate-800">{r.label}</span>
                  )}
                  {isCustom ? (
                    <div className="flex items-center gap-1">
                      <span className="text-slate-500 text-sm">$</span>
                      <input type="number" step="0.01" value={r.amount} placeholder="0.00"
                        onChange={(e) => patchAddon(r.uid, { amount: e.target.value })}
                        className="w-24 rounded border border-slate-300 px-1 py-1 text-sm text-right" />
                    </div>
                  ) : (
                    <span className="w-24 text-right font-mono text-sm text-slate-700">
                      {(eff?.amount_cents ?? 0) < 0 ? '−' : '+'}{fmt(Math.abs(eff?.amount_cents ?? 0))}
                    </span>
                  )}
                  {/* Submit: catalog ref OR custom label+amount (server re-resolves catalog). */}
                  <input type="hidden" name={`addon_ref_${i}`} value={r.category ? `${r.category}:${r.optionId}` : ''} />
                  <input type="hidden" name={`addon_label_${i}`} value={isCustom ? r.label : ''} />
                  <input type="hidden" name={`addon_amount_${i}`} value={isCustom ? r.amount : ''} />
                  <button type="button" onClick={() => removeAddon(r.uid)}
                    className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600" title="Remove add-on">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              );
            })}
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

        <label className="mt-3 block">
          <span className={labelCls}>First tuition payment date *</span>
          <input
            type="date" name="first_due_date" required value={firstDueDate}
            onChange={(e) => setFirstDueDate(e.target.value)}
            className={inputCls + ' max-w-[12rem]'}
          />
          <span className="mt-0.5 block text-[11px] text-slate-500">
            When the first installment drafts. The family signs now but isn&rsquo;t charged tuition until this date
            (the enrollment deposit is due at signing). Autopay then drafts each installment automatically.
          </span>
        </label>
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
            {gridAddonTotal > 0 ? <div className="flex justify-between"><span>Grid add-ons</span><span className="tabular-nums">+{fmt(gridAddonTotal)}</span></div> : null}
            {addonEffs.map((o) => (
              <div key={o.uid} className="flex justify-between">
                <span>{o.label}</span>
                <span className="tabular-nums">{o.amount_cents < 0 ? '−' : '+'}{fmt(Math.abs(o.amount_cents))}</span>
              </div>
            ))}
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
