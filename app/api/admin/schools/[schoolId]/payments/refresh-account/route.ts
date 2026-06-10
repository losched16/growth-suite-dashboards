// POST /api/admin/schools/{schoolId}/payments/refresh-account
//
// Pulls the school's connected Stripe account status straight from
// Stripe and writes it to payment_accounts. This is the on-demand
// sync the operator runs after finishing (or continuing) Stripe
// onboarding — we don't want to depend solely on the account.updated
// webhook, which may not be wired in every environment (e.g. when
// STRIPE_WEBHOOK_SECRET / a test-mode Connect webhook endpoint isn't
// configured). charges_enabled flipping here is what unlocks the
// invoice pay page.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { stripe } from '@/lib/stripe/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type Params = Promise<{ schoolId: string }>;

function safeReturn(returnTo: string | null, fallback: string): string {
  if (returnTo && /^\/(admin|school)\/[A-Za-z0-9_-]+(\/[^?#]*)?(\?[^#]*)?$/.test(returnTo)) return returnTo;
  return fallback;
}

function back(request: NextRequest, schoolId: string, q: { msg?: string; err?: string }, returnTo: string | null) {
  const url = request.nextUrl.clone();
  const target = safeReturn(returnTo, `/admin/${schoolId}/payments`);
  const [path, qs] = target.split('?');
  url.pathname = path;
  url.search = qs ? `?${qs}` : '';
  if (q.msg) url.searchParams.set('msg', q.msg);
  if (q.err) url.searchParams.set('err', q.err);
  return NextResponse.redirect(url, 303);
}

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId } = await params;
  const fd = await request.formData().catch(() => null);
  const returnTo = fd ? (String(fd.get('return_to') ?? '').trim() || null) : null;

  const { rows } = await query<{ stripe_account_id: string }>(
    `SELECT stripe_account_id FROM payment_accounts WHERE school_id = $1`,
    [schoolId],
  );
  const acctId = rows[0]?.stripe_account_id;
  if (!acctId) {
    return back(request, schoolId, { err: 'No Stripe account connected yet.' }, returnTo);
  }

  try {
    const account = await stripe().accounts.retrieve(acctId);
    await query(
      `UPDATE payment_accounts
          SET charges_enabled = $2,
              payouts_enabled = $3,
              details_submitted = $4,
              requirements_currently_due = $5::jsonb,
              last_synced_at = now(),
              updated_at = now()
        WHERE school_id = $1`,
      [
        schoolId,
        account.charges_enabled,
        account.payouts_enabled,
        account.details_submitted,
        JSON.stringify(account.requirements?.currently_due ?? []),
      ],
    );

    const ready = account.charges_enabled && account.payouts_enabled;
    const msg = ready
      ? 'Stripe status refreshed — the account is connected and can accept payments.'
      : account.charges_enabled
        ? 'Stripe status refreshed — charges are enabled (payouts still pending).'
        : account.details_submitted
          ? 'Stripe status refreshed — details submitted, but Stripe is still reviewing. Charges not enabled yet.'
          : 'Stripe status refreshed — onboarding is still incomplete. Finish it in Stripe, then refresh again.';
    return back(request, schoolId, { msg }, returnTo);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return back(request, schoolId, { err: `Couldn't refresh from Stripe: ${detail}` }, returnTo);
  }
}
