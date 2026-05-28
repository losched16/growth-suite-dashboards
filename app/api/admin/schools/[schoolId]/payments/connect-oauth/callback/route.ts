// GET /api/admin/schools/{schoolId}/payments/connect-oauth/callback
//
// Stripe redirects the operator here after they authorize on
// connect.stripe.com. Query params (set by Stripe):
//   code=ac_xxx        the one-time authorization code (success path)
//   state=...          the HMAC-signed CSRF token we minted in /start
//   scope=read_write   echoed back
//   error=...          set if the operator denied / canceled
//   error_description  human-readable error message
//
// We verify state → exchange code for stripe_user_id → persist into
// payment_accounts → redirect the operator back to /school/.../payments
// with a success or error toast.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { verifyOAuthState, exchangeAndPersist } from '@/lib/stripe/connect-oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type Params = Promise<{ schoolId: string }>;

function bounce(request: NextRequest, schoolPath: string, qs: { msg?: string; err?: string }) {
  const url = new URL(schoolPath, request.url);
  if (qs.msg) url.searchParams.set('msg', qs.msg);
  if (qs.err) url.searchParams.set('err', qs.err);
  return NextResponse.redirect(url, 303);
}

export async function GET(request: NextRequest, { params }: { params: Params }) {
  const { schoolId } = await params;
  const sp = request.nextUrl.searchParams;

  // Resolve a school-iframe-friendly destination so the operator lands
  // back on the Payments → Settings tab regardless of success / failure.
  const { rows: schoolRows } = await query<{ ghl_location_id: string }>(
    `SELECT ghl_location_id FROM schools WHERE id = $1`, [schoolId],
  );
  const locationId = schoolRows[0]?.ghl_location_id;
  const backPath = locationId
    ? `/school/${locationId}/payments?tab=settings`
    : `/admin/${schoolId}/payments`;

  // Operator denied / cancelled on Stripe's side.
  const errParam = sp.get('error');
  if (errParam) {
    const desc = sp.get('error_description') ?? errParam;
    return bounce(request, backPath, { err: `Stripe declined the connection: ${desc}` });
  }

  const code = sp.get('code');
  const state = sp.get('state');
  if (!code || !state) {
    return bounce(request, backPath, { err: 'Stripe callback was missing code or state.' });
  }

  // CSRF + tampering check. signOAuthState binds the state to this
  // specific schoolId, so a code stolen from another school's session
  // can't be used to attach to ours.
  try {
    verifyOAuthState(state, schoolId);
  } catch {
    return bounce(request, backPath, { err: 'OAuth state token failed verification (expired or tampered).' });
  }

  try {
    const r = await exchangeAndPersist({
      schoolId,
      code,
      connectedByEmail: 'operator@growthsuite.local', // TODO: surface real operator email when auth captures it
    });
    return bounce(request, backPath, {
      msg: `Connected existing Stripe account ${r.stripeAccountId}${r.livemode ? ' (live mode)' : ' (test mode)'}.`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return bounce(request, backPath, { err: `Stripe token exchange failed: ${msg}` });
  }
}
