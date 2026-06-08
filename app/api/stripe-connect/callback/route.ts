// GET /api/stripe-connect/callback
//
// THE callback URL registered with Stripe Connect — single school-agnostic
// endpoint. Stripe only allows you to register a small finite set of
// redirect URIs in your Connect platform settings, so we can't use one
// URL per school. The schoolId travels through the HMAC-signed `state`
// param instead.
//
// Stripe Dashboard config: Settings → Connect → Onboarding options →
//   Standard → Redirect URIs → add
//   https://growth-suite-dashboards.vercel.app/api/stripe-connect/callback
//
// Query params (Stripe-set):
//   code              authorization code on success
//   state             our HMAC-signed token (encodes schoolId)
//   scope             read_write (echo)
//   error             set if the operator denied / cancelled
//   error_description human-readable
//
// We verify state → decode schoolId → exchange code for stripe_user_id
// → persist payment_accounts → 303 back to the school's payments hub.
//
// Backward-compat: the legacy per-school callback at
// /api/admin/schools/{schoolId}/payments/connect-oauth/callback still
// exists (verifies state against the URL's schoolId). Once every running
// platform is pointed at this URL the legacy route can be deleted.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { verifyOAuthState, exchangeAndPersist } from '@/lib/stripe/connect-oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function bounce(request: NextRequest, backPath: string, qs: { msg?: string; err?: string }) {
  const url = new URL(backPath, request.url);
  if (qs.msg) url.searchParams.set('msg', qs.msg);
  if (qs.err) url.searchParams.set('err', qs.err);
  return NextResponse.redirect(url, 303);
}

// Fallback when state can't be decoded — send the operator to a generic
// admin landing rather than crashing, since we don't know which school
// they were connecting on behalf of.
const GENERIC_FALLBACK = '/admin';

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;

  // Operator denied / cancelled on Stripe's side.
  const errParam = sp.get('error');
  const code = sp.get('code');
  const state = sp.get('state');

  // No state at all → nothing we can do but bounce to the admin index.
  if (!state) {
    const desc = errParam ?? 'Stripe callback was missing the state token.';
    return bounce(request, GENERIC_FALLBACK, { err: `Stripe OAuth aborted: ${desc}` });
  }

  // Decode + verify state first — gives us the schoolId so we can
  // redirect back to the right school's payments hub regardless of
  // success / failure on the next steps.
  let schoolId: string;
  try {
    ({ schoolId } = verifyOAuthState(state));
  } catch {
    return bounce(request, GENERIC_FALLBACK, {
      err: 'Stripe OAuth state failed verification (expired or tampered). Please start over.',
    });
  }

  // Resolve the school-iframe destination so the operator lands back
  // on the Payments → Settings tab in their dashboard.
  const { rows: schoolRows } = await query<{ ghl_location_id: string | null }>(
    `SELECT ghl_location_id FROM schools WHERE id = $1`,
    [schoolId],
  );
  const locationId = schoolRows[0]?.ghl_location_id;
  const backPath = locationId
    ? `/school/${locationId}/payments?tab=settings`
    : `/admin/${schoolId}/payments`;

  // Operator denied / cancelled on Stripe — surface the reason and bounce.
  if (errParam) {
    const desc = sp.get('error_description') ?? errParam;
    return bounce(request, backPath, { err: `Stripe declined the connection: ${desc}` });
  }

  if (!code) {
    return bounce(request, backPath, { err: 'Stripe callback was missing the authorization code.' });
  }

  try {
    const r = await exchangeAndPersist({
      schoolId,
      code,
      connectedByEmail: 'operator@growthsuite.local',
    });
    return bounce(request, backPath, {
      msg: `Connected existing Stripe account ${r.stripeAccountId}${r.livemode ? ' (live mode)' : ' (test mode)'}.`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return bounce(request, backPath, { err: `Stripe token exchange failed: ${msg}` });
  }
}
