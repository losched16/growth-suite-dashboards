// Recompute a family's tuition breakdown for a NEW grid (e.g. 5-day → 4-day)
// and/or a NEW payment plan, auto-rescaling percentage discounts against the
// new base instead of leaving stale fixed-dollar amounts behind.
//
// School-confirmed model (driven by school_payment_config.discount_rules):
//   discountable = base grid tuition + extended care      (basis)
//   pay-timing discount depends on the plan (annual 3% / semi-annual 2% /
//     monthly none); sibling 10% is "sticky" (kept if the family had it).
//   each discount is taken off `discountable`, non-compounding.
//   total = base + extended care − deposit − discounts + development fee
//
// Pure function — no DB — so it's unit-testable and drives both the live
// preview and the actual save.

export interface AddonSnap {
  key: string;
  label: string;
  amount_cents: number;
}

export interface OverrideLine {
  description: string;
  amount_cents: number;
  category: string; // 'tuition' | 'tuition_addon'
}

export interface DiscountRuleEntry {
  key: string;
  label: string;
  bps: number;
}

export interface DiscountRules {
  basis: 'base_plus_extended_care' | 'base_only' | string;
  compounding: boolean;
  extended_care_keys: string[];
  carry_over_keys: string[];
  pay_timing_by_plan: Record<string, DiscountRuleEntry | null>;
  sibling: DiscountRuleEntry | null;
}

export interface RecomputeInput {
  currentAddons: AddonSnap[];
  newBaseCents: number; // new grid annual_tuition_cents
  newGridLabel: string; // tuition line description
  newPlanSlug: string; // 'annual' | 'semi-annual' | 'monthly'
  rules: DiscountRules | null;
}

export interface RecomputeResult {
  addons: AddonSnap[]; // for family_tuition_enrollments.addons (no base line)
  overrideLines: OverrideLine[]; // for generateTuitionEnrollment (INCLUDES base)
  totalAnnualCents: number;
  discountBasisCents: number;
  notes: string[]; // human-readable flags for the operator (e.g. scholarship)
}

const pct = (bps: number, basisCents: number) =>
  -Math.round((bps / 10000) * basisCents);

export function recomputePlanBreakdown(input: RecomputeInput): RecomputeResult {
  const { currentAddons, newBaseCents, newGridLabel, newPlanSlug, rules } = input;
  const notes: string[] = [];

  // No rules configured → carry every addon forward untouched and flag it.
  if (!rules) {
    const total = newBaseCents + currentAddons.reduce((s, a) => s + a.amount_cents, 0);
    notes.push('No discount rules configured for this school — discounts were carried forward unchanged. Review them manually.');
    return {
      addons: currentAddons,
      overrideLines: [
        { description: newGridLabel, amount_cents: newBaseCents, category: 'tuition' },
        ...currentAddons.map((a) => ({ description: a.label, amount_cents: a.amount_cents, category: 'tuition_addon' })),
      ],
      totalAnnualCents: total,
      discountBasisCents: newBaseCents,
      notes,
    };
  }

  const extKeys = new Set(rules.extended_care_keys);
  const carryKeys = new Set(rules.carry_over_keys);
  const discountKeys = new Set<string>();
  for (const e of Object.values(rules.pay_timing_by_plan)) if (e) discountKeys.add(e.key);
  if (rules.sibling) discountKeys.add(rules.sibling.key);

  // 1. Carry forward the fixed-dollar addons (extended care, deposit, dev fee,
  //    scholarship) at their existing amounts — these don't depend on day-count.
  const carried = currentAddons.filter((a) => carryKeys.has(a.key) && !discountKeys.has(a.key));
  const extCents = carried
    .filter((a) => extKeys.has(a.key))
    .reduce((s, a) => s + a.amount_cents, 0);

  if (carried.some((a) => a.key === 'scholarship')) {
    notes.push('This family has a scholarship/override line — its amount was carried forward as-is and may need re-checking against the new total.');
  }

  // 2. Discount basis.
  const discountBasisCents = rules.basis === 'base_only' ? newBaseCents : newBaseCents + extCents;

  // 3. Which discounts apply: the plan's pay-timing discount + (sticky) sibling.
  const wantSibling = !!rules.sibling && currentAddons.some((a) => a.key === rules.sibling!.key);
  const payTiming = rules.pay_timing_by_plan[newPlanSlug] ?? null;

  const discountAddons: AddonSnap[] = [];
  if (payTiming && payTiming.bps > 0) {
    discountAddons.push({ key: payTiming.key, label: payTiming.label, amount_cents: pct(payTiming.bps, discountBasisCents) });
  }
  if (wantSibling && rules.sibling) {
    discountAddons.push({ key: rules.sibling.key, label: rules.sibling.label, amount_cents: pct(rules.sibling.bps, discountBasisCents) });
  }

  // 4. Assemble in a stable, human-readable order: extended care, deposit,
  //    discounts, then any other carried fees (development fee, scholarship).
  const byKey = (k: string) => carried.find((a) => a.key === k);
  const ordered: AddonSnap[] = [];
  for (const k of rules.extended_care_keys) { const a = byKey(k); if (a) ordered.push(a); }
  const deposit = byKey('deposit'); if (deposit) ordered.push(deposit);
  ordered.push(...discountAddons);
  for (const a of carried) {
    if (extKeys.has(a.key) || a.key === 'deposit') continue; // already placed
    ordered.push(a); // development_fee, scholarship, anything else
  }

  const totalAnnualCents = newBaseCents + ordered.reduce((s, a) => s + a.amount_cents, 0);

  const overrideLines: OverrideLine[] = [
    { description: newGridLabel, amount_cents: newBaseCents, category: 'tuition' },
    ...ordered.map((a) => ({ description: a.label, amount_cents: a.amount_cents, category: 'tuition_addon' })),
  ];

  return { addons: ordered, overrideLines, totalAnnualCents, discountBasisCents, notes };
}
