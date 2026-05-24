// POST /api/admin/schools/[schoolId]/purchases/[purchaseId]/refund
//
// Issues a Stripe refund on the school's Connect account and updates
// the product_purchases row. Idempotent within Stripe (we generate an
// idempotency key from the refund attempt). Only operators (session-
// authed) can call.
//
// Body:
//   { amount_cents: number, reason?: 'requested_by_customer' | 'duplicate' | 'fraudulent' | 'other' }

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { stripe } from '@/lib/stripe/client';
import { query } from '@/lib/db';
import type Stripe from 'stripe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string; purchaseId: string }>;

const STRIPE_REASONS = new Set(['requested_by_customer', 'duplicate', 'fraudulent']);

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const ck = await cookies();
  if (!verifySessionToken(ck.get(SESSION_COOKIE)?.value)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { schoolId, purchaseId } = await params;

  let body: { amount_cents?: number; reason?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const amountCents = Math.max(0, Math.floor(body.amount_cents ?? 0));
  if (amountCents <= 0) {
    return NextResponse.json({ error: 'invalid_amount' }, { status: 400 });
  }
  const reasonForStripe = body.reason && STRIPE_REASONS.has(body.reason) ? body.reason as Stripe.RefundCreateParams.Reason : undefined;

  // Pull the purchase + the school's Stripe Connect account
  const { rows } = await query<{
    id: string;
    status: string;
    stripe_payment_intent_id: string | null;
    stripe_charge_id: string | null;
    stripe_subscription_id: string | null;
    total_amount_cents: number;
    refunded_amount_cents: number;
    stripe_account_id: string | null;
  }>(
    `SELECT pp.id, pp.status, pp.stripe_payment_intent_id, pp.stripe_charge_id,
            pp.stripe_subscription_id, pp.total_amount_cents, pp.refunded_amount_cents,
            pa.stripe_account_id
       FROM product_purchases pp
       LEFT JOIN payment_accounts pa ON pa.school_id = pp.school_id
      WHERE pp.id = $1 AND pp.school_id = $2`,
    [purchaseId, schoolId],
  );
  if (rows.length === 0) {
    return NextResponse.json({ error: 'purchase_not_found' }, { status: 404 });
  }
  const p = rows[0];

  if (p.status !== 'succeeded' && p.status !== 'refunded') {
    return NextResponse.json(
      { error: 'not_refundable', detail: `Purchase status is "${p.status}" — only succeeded purchases can be refunded.` },
      { status: 409 },
    );
  }
  const remaining = p.total_amount_cents - p.refunded_amount_cents;
  if (amountCents > remaining) {
    return NextResponse.json(
      { error: 'amount_exceeds_remaining', detail: `Max refundable is ${remaining} cents.` },
      { status: 400 },
    );
  }
  if (!p.stripe_payment_intent_id && !p.stripe_charge_id) {
    return NextResponse.json(
      { error: 'no_stripe_ref', detail: 'Purchase has no Stripe charge reference to refund.' },
      { status: 409 },
    );
  }
  if (!p.stripe_account_id) {
    return NextResponse.json(
      { error: 'school_not_connected', detail: 'School has no Stripe Connect account.' },
      { status: 503 },
    );
  }

  // Issue the refund
  const s = stripe();
  try {
    const refund = await s.refunds.create(
      {
        ...(p.stripe_payment_intent_id
          ? { payment_intent: p.stripe_payment_intent_id }
          : { charge: p.stripe_charge_id! }),
        amount: amountCents,
        reason: reasonForStripe,
        metadata: {
          gs_purchase_id: purchaseId,
          gs_refund_reason: body.reason ?? 'other',
        },
      },
      {
        stripeAccount: p.stripe_account_id,
        // Idempotency — same purchase + amount + minute window won't double-refund
        idempotencyKey: `refund-${purchaseId}-${amountCents}-${Math.floor(Date.now() / 60_000)}`,
      },
    );

    // Update DB. The charge.refunded webhook will also fire but we
    // optimistically update so the UI feels fast and is consistent
    // even if the webhook is delayed.
    const newRefundedTotal = p.refunded_amount_cents + amountCents;
    const newStatus = newRefundedTotal >= p.total_amount_cents ? 'refunded' : 'succeeded';
    await query(
      `UPDATE product_purchases
          SET refunded_amount_cents = $1,
              refund_reason = COALESCE($2, refund_reason),
              refunded_at = COALESCE(refunded_at, now()),
              status = $3,
              updated_at = now()
        WHERE id = $4`,
      [newRefundedTotal, body.reason ?? null, newStatus, purchaseId],
    );

    return NextResponse.json({
      ok: true,
      refund_id: refund.id,
      refunded_amount_cents: amountCents,
      total_refunded: newRefundedTotal,
      status: newStatus,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: 'stripe_refund_failed', detail: msg }, { status: 502 });
  }
}
