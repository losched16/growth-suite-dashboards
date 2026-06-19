// Schedule a one-off (incidental) invoice to auto-charge N days after it
// hits the parent portal — DGM's "all one-off invoices auto-bill within 5
// days when a card is on file" policy.
//
// Reads the school's `autopay_oneoff_after_days` setting (NULL = off) and,
// when set, attaches the family's saved default card + an autopay_charge_on
// date of (today + N). The existing daily autopay cron performs the charge,
// and only once the school is live (billing_active gates it) — so dry-run
// never charges. No card on file → nothing scheduled (stays manual-pay).
//
// Only positive charges to a real family are auto-billed; credits / $0 /
// drafts / non-family recipients are skipped by the caller.

import type { query } from '@/lib/db';

// `q` is a query-capable handle — pass the transaction's `q` so this runs
// atomically with the invoice insert, or the pooled `query` directly.
export async function scheduleOneoffAutopay(
  q: typeof query,
  opts: {
    schoolId: string;
    familyId: string | null;
    invoiceId: string;
    totalCents: number;
    afterDays: number | null;
  },
): Promise<boolean> {
  const { schoolId, familyId, invoiceId, totalCents, afterDays } = opts;
  if (afterDays == null || afterDays < 0 || !familyId || totalCents <= 0) return false;

  const { rows: pm } = await q<{ id: string }>(
    `SELECT id FROM payment_methods
      WHERE school_id = $1 AND family_id = $2 AND active = true
      ORDER BY is_default DESC, created_at DESC LIMIT 1`,
    [schoolId, familyId],
  );
  if (!pm[0]) return false; // no card on file → leave it manual-pay

  const chargeOn = new Date();
  chargeOn.setUTCDate(chargeOn.getUTCDate() + afterDays);
  await q(
    `UPDATE invoices
        SET autopay_enabled = true,
            autopay_payment_method_id = $1,
            autopay_charge_on = $2::date,
            retry_attempt_count = 0,
            next_retry_at = NULL,
            updated_at = now()
      WHERE id = $3`,
    [pm[0].id, chargeOn.toISOString().slice(0, 10), invoiceId],
  );
  return true;
}
