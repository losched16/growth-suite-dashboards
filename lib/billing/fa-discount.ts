// Keep a school's financial-aid award in sync with its tuition discount.
//
// A decided FA application with a positive award maps to one
// discount_policies row of kind='financial_aid', keyed to the FA
// application id and applied against tuition line categories. This is the
// single source of that mapping — both the automatic path (fa/set-award,
// inside its transaction) and the manual operator button
// (payments/fa-to-discount) call it, so they can never drift.
//
// Idempotent and reversible:
//   - decided + award > 0  → create (or update) an ACTIVE policy at the
//                            award amount.
//   - anything else        → deactivate any existing policy for this app
//                            (award zeroed, declined, withdrawn, back to
//                            under_review). We never delete — history and
//                            the fa_application_id link are preserved.
//
// Note: the discount evaluator also live-checks fa_applications.status ===
// 'decided' (lib/billing/discounts.ts), so a status reversal is already a
// safety net; deactivating here keeps is_active honest and stops a stale
// amount from silently re-applying if the app is later re-decided.

import type { query } from '@/lib/db';

export type FaDiscountAction = 'created' | 'updated' | 'deactivated' | 'noop';

export interface FaDiscountResult {
  action: FaDiscountAction;
  discountPolicyId: string | null;
}

// `q` is either the pool `query` or a transaction executor (both are typed
// `typeof query`), so this composes inside withTransaction for atomicity.
export async function syncFaDiscountForApplication(
  q: typeof query,
  schoolId: string,
  faApplicationId: string,
): Promise<FaDiscountResult> {
  const { rows: faRows } = await q<{
    family_id: string;
    academic_year: string;
    status: string;
    recommended_award: string | null;
  }>(
    `SELECT family_id, academic_year, status, recommended_award
       FROM fa_applications
      WHERE id = $1 AND school_id = $2`,
    [faApplicationId, schoolId],
  );
  const fa = faRows[0];
  if (!fa) return { action: 'noop', discountPolicyId: null };

  const awardDollars = Number(fa.recommended_award ?? 0);
  const awardCents = Number.isFinite(awardDollars) && awardDollars > 0
    ? Math.round(awardDollars * 100)
    : 0;
  const shouldBeActive = fa.status === 'decided' && awardCents > 0;

  const { rows: existingRows } = await q<{ id: string }>(
    `SELECT id FROM discount_policies
      WHERE school_id = $1 AND fa_application_id = $2 LIMIT 1`,
    [schoolId, faApplicationId],
  );
  const existing = existingRows[0];

  // Not eligible → deactivate any existing policy, create nothing.
  if (!shouldBeActive) {
    if (existing) {
      await q(
        `UPDATE discount_policies SET is_active = false, updated_at = now() WHERE id = $1`,
        [existing.id],
      );
      return { action: 'deactivated', discountPolicyId: existing.id };
    }
    return { action: 'noop', discountPolicyId: null };
  }

  // Eligible → refresh the amount + re-activate an existing policy…
  if (existing) {
    await q(
      `UPDATE discount_policies
          SET amount_cents = $1, max_discount_cents = $1, is_active = true, updated_at = now()
        WHERE id = $2`,
      [awardCents, existing.id],
    );
    return { action: 'updated', discountPolicyId: existing.id };
  }

  // …or create a new one, labelled with the family + year.
  const { rows: famRows } = await q<{ display_name: string | null }>(
    `SELECT COALESCE(NULLIF(f.display_name, ''),
                     CONCAT_WS(' ', p.first_name, p.last_name),
                     '(unnamed family)') AS display_name
       FROM families f
       LEFT JOIN LATERAL (
         SELECT first_name, last_name FROM parents
         WHERE family_id = f.id AND is_primary = true LIMIT 1
       ) p ON true
      WHERE f.id = $1`,
    [fa.family_id],
  );
  const familyName = famRows[0]?.display_name ?? 'Family';

  const ins = await q<{ id: string }>(
    `INSERT INTO discount_policies
       (school_id, kind, display_name, amount_cents, max_discount_cents,
        applies_to_categories, conditions, fa_application_id, is_active)
     VALUES ($1, 'financial_aid', $2, $3, $3, $4, '{}'::jsonb, $5, true)
     RETURNING id`,
    [
      schoolId,
      `Financial aid — ${familyName} (${fa.academic_year})`,
      awardCents,
      // Only subtract from tuition + tuition add-on line categories; leave
      // trips/incidentals untouched.
      ['tuition', 'tuition_addon'],
      faApplicationId,
    ],
  );
  return { action: 'created', discountPolicyId: ins.rows[0].id };
}
