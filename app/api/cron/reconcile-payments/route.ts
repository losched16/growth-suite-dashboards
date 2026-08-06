// GET/POST /api/cron/reconcile-payments
//
// Reconciles our `payments` rows that are stuck in 'pending' against their
// ACTUAL status in Stripe (on the school's connected account). A payment
// can get stranded in 'pending' when the Stripe webhook is missed (e.g. the
// endpoint was disabled) — Stripe doesn't re-deliver old events, so nothing
// heals it and the Payments hub shows a payment as unprocessed that Stripe
// already settled.
//
// For each stale pending payment we retrieve the PaymentIntent and:
//   succeeded    → mark the payment 'succeeded' + apply it to its invoice
//                  (amount_paid += amount, status → paid/partially_paid).
//   processing   → leave 'pending' (ACH still clearing — legitimately open).
//   canceled /   → mark 'failed' (abandoned or dead attempt; clears it from
//   requires_*      the pending list so the office reconciles cleanly).
//
// SAFE BY DEFAULT: dry-run unless ?apply=1. The pending→succeeded/failed
// UPDATE is guarded on `status='pending'` so a re-run never double-applies
// a payment to an invoice. Auth: Bearer CRON_SECRET (same as the other crons).
//
// Query params:
//   apply=1              actually write changes (default: dry-run report only)
//   school=<school_id>   limit to one school (default: all)
//   min_age_hours=N      only touch payments older than N hours (default 2 —
//                        gives a just-created in-flight charge time to settle
//                        via the normal webhook before we reconcile it)

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { stripe } from '@/lib/stripe/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function authorize(request: NextRequest): boolean {
  const auth = request.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return false;
  const presented = auth.slice('Bearer '.length).trim();
  const candidates = [process.env.CRON_SECRET, process.env.INTERNAL_API_TOKEN]
    .filter((s): s is string => !!s && s.length > 0);
  return candidates.some((c) => c === presented);
}

interface PendingRow {
  id: string;
  school_id: string;
  invoice_id: string | null;
  amount_cents: number;
  pi: string;
  acct: string | null;
  method: string | null;
  invoice_number: string | null;
  istatus: string | null;
  family: string | null;
}

// Stripe PI statuses that mean "no charge landed / never will" → mark failed.
const DEAD = new Set(['canceled', 'requires_payment_method', 'requires_action', 'requires_confirmation']);

export async function GET(request: NextRequest) { return run(request); }
export async function POST(request: NextRequest) { return run(request); }

async function run(request: NextRequest) {
  if (!authorize(request)) return new NextResponse('unauthorized', { status: 401 });

  const url = new URL(request.url);
  const apply = url.searchParams.get('apply') === '1';
  const school = url.searchParams.get('school');
  const minAgeHours = Math.max(0, Number(url.searchParams.get('min_age_hours') ?? '2') || 2);

  const { rows: pend } = await query<PendingRow>(
    `SELECT p.id, p.school_id, p.invoice_id, p.amount_cents,
            p.stripe_payment_intent_id AS pi, a.stripe_account_id AS acct,
            p.stripe_payment_method_type AS method,
            i.invoice_number, i.status AS istatus,
            COALESCE(f.display_name, '(unnamed)') AS family
       FROM payments p
       LEFT JOIN payment_accounts a ON a.school_id = p.school_id
       LEFT JOIN invoices i ON i.id = p.invoice_id
       LEFT JOIN families f ON f.id = p.family_id
      WHERE p.status = 'pending'
        AND p.stripe_payment_intent_id IS NOT NULL
        AND p.created_at < now() - make_interval(hours => $1::int)
        AND ($2::uuid IS NULL OR p.school_id = $2::uuid)
      ORDER BY p.created_at`,
    [minAgeHours, school],
  );

  const results: Array<Record<string, unknown>> = [];
  const tally: Record<string, number> = {};

  for (const r of pend) {
    let stripeStatus = 'unknown';
    let action = 'none';
    let note = '';
    if (!r.acct) {
      stripeStatus = 'no_connected_account';
      action = 'skip';
    } else {
      try {
        const pi = await stripe().paymentIntents.retrieve(r.pi, {}, { stripeAccount: r.acct });
        stripeStatus = pi.status;
        const charge = typeof pi.latest_charge === 'string'
          ? pi.latest_charge
          : (pi.latest_charge && 'id' in pi.latest_charge ? pi.latest_charge.id : null);

        if (stripeStatus === 'succeeded') {
          action = r.istatus === 'paid' ? 'mark_succeeded (invoice already paid — likely overpayment/dup)' : 'mark_succeeded + apply_to_invoice';
          if (apply) {
            const upd = await query(
              `UPDATE payments SET status='succeeded',
                      stripe_charge_id = COALESCE(stripe_charge_id, $2), updated_at = now()
                WHERE id = $1 AND status = 'pending'`,
              [r.id, charge],
            );
            if ((upd.rowCount ?? 0) > 0 && r.invoice_id) {
              await query(
                `UPDATE invoices
                    SET amount_paid_cents = amount_paid_cents + $1,
                        status = CASE
                          WHEN amount_paid_cents + $1 >= total_cents THEN 'paid'
                          WHEN amount_paid_cents + $1 > 0 THEN 'partially_paid'
                          ELSE status END,
                        paid_at = CASE WHEN amount_paid_cents + $1 >= total_cents THEN now() ELSE paid_at END,
                        updated_at = now()
                  WHERE id = $2`,
                [r.amount_cents, r.invoice_id],
              );
            }
          }
        } else if (stripeStatus === 'processing') {
          action = 'leave_pending (ACH clearing)';
        } else if (DEAD.has(stripeStatus)) {
          action = 'mark_failed';
          if (apply) {
            await query(
              `UPDATE payments SET status='failed',
                      failure_message = COALESCE(failure_message, $2), updated_at = now()
                WHERE id = $1 AND status = 'pending'`,
              [r.id, `Reconciled: Stripe status ${stripeStatus}`],
            );
          }
        } else {
          action = 'leave_pending (unhandled status)';
        }
      } catch (e) {
        stripeStatus = 'retrieve_error';
        action = 'skip';
        note = e instanceof Error ? e.message : String(e);
      }
    }

    const key = `${stripeStatus} → ${action}`;
    tally[key] = (tally[key] ?? 0) + 1;
    results.push({
      family: r.family, amount: `$${(r.amount_cents / 100).toFixed(2)}`, method: r.method,
      invoice: r.invoice_number, invoice_status: r.istatus,
      our_status: 'pending', stripe_status: stripeStatus, action,
      ...(note ? { note } : {}),
    });
  }

  return NextResponse.json({
    ok: true, mode: apply ? 'APPLIED' : 'dry-run',
    school: school ?? 'all', min_age_hours: minAgeHours,
    scanned: pend.length, tally, results,
  });
}
