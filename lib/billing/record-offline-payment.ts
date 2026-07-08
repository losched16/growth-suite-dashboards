// Record an OFFLINE payment (check / cash / bank transfer / other) against an
// invoice — for tuition installments OR one-off charges. Mirrors what a Stripe
// payment does: inserts a payments row, adds to amount_paid_cents, flips the
// invoice to paid / partially_paid, and (when fully paid) drops it out of
// autopay so a check-paying family is never also auto-charged. No card is
// touched. Pass a transaction handle so the insert + update run atomically.
import type { query } from '@/lib/db';

export interface RecordOfflineResult {
  ok: boolean;
  error?: string;
  fullyPaid?: boolean;
  amountCents?: number;
  method?: string;
}

export async function recordOfflinePayment(
  q: typeof query,
  opts: {
    schoolId: string;
    invoiceId: string;
    amountCents: number;
    method: string;
    reference: string;
    paidDate: string | null; // 'YYYY-MM-DD' or null (defaults to now)
  },
): Promise<RecordOfflineResult> {
  const { schoolId, invoiceId, amountCents, reference, paidDate } = opts;
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return { ok: false, error: 'Enter a payment amount greater than $0.' };
  }

  const { rows } = await q<{ family_id: string | null; total_cents: number; amount_paid_cents: number; status: string }>(
    `SELECT family_id, total_cents, amount_paid_cents, status
       FROM invoices WHERE id = $1 AND school_id = $2`,
    [invoiceId, schoolId],
  );
  const iv = rows[0];
  if (!iv) return { ok: false, error: 'Invoice not found.' };
  if (iv.status !== 'open' && iv.status !== 'partially_paid') {
    return { ok: false, error: `Can't record a payment on a ${iv.status} invoice.` };
  }

  const rawMethod = (opts.method || 'check').trim().toLowerCase() || 'check';
  const methodLabel = reference ? `${rawMethod} #${reference}` : rawMethod;
  const noteLine = `\n[${new Date().toISOString().slice(0, 10)}] Offline payment: $${(amountCents / 100).toFixed(2)} via ${rawMethod}${reference ? ` (#${reference})` : ''}`;
  const fullyPaid = iv.amount_paid_cents + amountCents >= iv.total_cents;

  await q(
    `INSERT INTO payments
       (school_id, invoice_id, family_id, amount_cents, fee_cents, platform_fee_cents,
        status, stripe_payment_method_type, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 0, 0, 'succeeded', $5, COALESCE($6::timestamptz, now()), now())`,
    [schoolId, invoiceId, iv.family_id, amountCents, methodLabel, paidDate],
  );
  await q(
    `UPDATE invoices
        SET amount_paid_cents = amount_paid_cents + $1,
            status = CASE WHEN amount_paid_cents + $1 >= total_cents THEN 'paid'
                          WHEN amount_paid_cents + $1 > 0 THEN 'partially_paid'
                          ELSE status END,
            paid_at = CASE WHEN amount_paid_cents + $1 >= total_cents THEN COALESCE($3::timestamptz, now()) ELSE paid_at END,
            autopay_enabled = CASE WHEN amount_paid_cents + $1 >= total_cents THEN false ELSE autopay_enabled END,
            internal_note = COALESCE(internal_note, '') || $4,
            updated_at = now()
      WHERE id = $2`,
    [amountCents, invoiceId, paidDate, noteLine],
  );

  return { ok: true, fullyPaid, amountCents, method: rawMethod };
}
