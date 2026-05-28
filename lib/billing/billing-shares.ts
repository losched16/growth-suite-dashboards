// Split-billing helpers: shared between the tuition plan generator,
// one-off invoice creation, the admin split-editor API, and the GHL
// writeback. Encapsulates the basis-point math + per-parent rounding
// so callers don't reimplement it (and accidentally drift on cents).

import { query } from '@/lib/db';
type QueryFn = typeof query;

export interface BillingShare {
  parent_id: string;
  share_basis_points: number;       // 5000 = 50%
  parent_first_name: string | null;
  parent_last_name: string | null;
  parent_email: string | null;
  parent_ghl_contact_id: string | null;
}

/**
 * Load every billing share for an enrollment, ordered so the largest
 * share goes first (rounding remainders flow to the LAST share — see
 * splitCents below — which is intentionally the smallest stake so the
 * largest payer never sees a penny over their stated %).
 *
 * Returns [] when the enrollment is jointly-billed (current default).
 */
export async function loadEnrollmentShares(
  schoolId: string,
  enrollmentId: string,
  q: QueryFn = query,
): Promise<BillingShare[]> {
  const { rows } = await q<BillingShare>(
    `SELECT s.parent_id, s.share_basis_points,
            p.first_name AS parent_first_name,
            p.last_name  AS parent_last_name,
            p.email      AS parent_email,
            p.ghl_contact_id AS parent_ghl_contact_id
       FROM enrollment_billing_shares s
       JOIN parents p ON p.id = s.parent_id
      WHERE s.school_id = $1
        AND s.enrollment_id = $2
      ORDER BY s.share_basis_points DESC, p.created_at ASC`,
    [schoolId, enrollmentId],
  );
  return rows;
}

/**
 * Split an integer cents value across N shares (basis points). Returns
 * one cents amount per share, in the same order as the input, summing
 * EXACTLY back to the input total — rounding remainders push onto the
 * LAST share so we never need decimal arithmetic.
 *
 * Example: splitCents(1330_00, [6000, 4000]) → [79800, 53200]
 *
 * Pre-condition: shares must sum to 10000 bp. Enforced by the DB
 * trigger on enrollment_billing_shares; we double-check here so a
 * caller passing an ad-hoc array still gets a sensible result.
 */
export function splitCents(totalCents: number, shareBp: readonly number[]): number[] {
  const sumBp = shareBp.reduce((a, b) => a + b, 0);
  if (sumBp !== 10000) {
    throw new Error(`splitCents: shares must sum to 10000 bp, got ${sumBp}`);
  }
  const out: number[] = [];
  let used = 0;
  for (let i = 0; i < shareBp.length; i++) {
    if (i === shareBp.length - 1) {
      // Last share absorbs the rounding remainder so the sum is exact.
      out.push(totalCents - used);
    } else {
      const portion = Math.round((totalCents * shareBp[i]) / 10000);
      out.push(portion);
      used += portion;
    }
  }
  return out;
}

/**
 * Format a basis-points value as a human-readable percentage string.
 *   5000 → "50%"
 *   6667 → "66.67%"
 */
export function formatBp(bp: number): string {
  if (bp % 100 === 0) return `${bp / 100}%`;
  return `${(bp / 100).toFixed(2)}%`;
}
