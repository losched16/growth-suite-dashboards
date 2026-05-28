// Stripe Connect OAuth flow — used when a school already has a Stripe
// account (e.g. they were taking payments through another tool or a
// previous platform) and wants to connect THAT existing account instead
// of creating a new one via Account Links.
//
// Flow:
//   1) Operator clicks "Connect existing Stripe account" on Settings.
//   2) /api/admin/.../payments/connect-oauth/start signs a CSRF state
//      token (HMAC over schoolId + expiry) and 303-redirects to
//      https://connect.stripe.com/oauth/v2/authorize?... with our
//      platform client_id + redirect_uri.
//   3) Stripe walks the school through authorization (they sign in to
//      their existing Stripe account; if they have multiple they pick
//      which one to connect).
//   4) Stripe redirects to our callback at
//      /api/admin/.../payments/connect-oauth/callback?code=...&state=...
//   5) Callback verifies state, exchanges code for stripe_user_id via
//      stripe.oauth.token({ grant_type: 'authorization_code', code }),
//      persists payment_accounts row, redirects to /school/.../payments.
//
// Required env vars:
//   STRIPE_CLIENT_ID   ca_... — your platform's OAuth Connect client_id.
//                              Grab from Stripe Dashboard → Settings →
//                              Connect → Onboarding options → "Standard"
//                              → toggle "Use OAuth" on.
//   SESSION_SECRET     used to HMAC-sign the state token (same secret
//                              the operator login already uses).

import crypto from 'node:crypto';
import { query } from '@/lib/db';
import { stripe } from './client';

const STATE_TTL_MS = 30 * 60 * 1000; // 30 minutes — generous; OAuth roundtrips can be slow

function stateSecret(): Buffer {
  const raw = process.env.SESSION_SECRET;
  if (!raw) throw new Error('SESSION_SECRET env var is required');
  return Buffer.from(raw, 'base64');
}

// Sign a payload of (schoolId, expiry) so the callback can verify the
// request came from our /start endpoint and hasn't been tampered with.
// Returns a base64url string: "<schoolId>.<expiryMs>.<sig>".
export function signOAuthState(schoolId: string): string {
  const expiry = Date.now() + STATE_TTL_MS;
  const payload = `${schoolId}.${expiry}`;
  const sig = crypto.createHmac('sha256', stateSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

// Returns the schoolId encoded in the state, or throws on any failure
// (bad shape, bad signature, expired). Callers should treat any throw
// as "redirect back with err=..." — never reveal the specific cause to
// the user (could leak signing oracle behavior).
export function verifyOAuthState(state: string, expectedSchoolId: string): void {
  const parts = state.split('.');
  if (parts.length !== 3) throw new Error('state shape');
  const [schoolId, expiryStr, sig] = parts;
  if (schoolId !== expectedSchoolId) throw new Error('state schoolId mismatch');
  const expected = crypto.createHmac('sha256', stateSecret()).update(`${schoolId}.${expiryStr}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) throw new Error('state sig length');
  if (!crypto.timingSafeEqual(a, b)) throw new Error('state sig mismatch');
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || expiry < Date.now()) throw new Error('state expired');
}

// Build the authorize URL Stripe expects. Prefills the school's email
// so the operator doesn't have to retype it when picking which Stripe
// account to connect.
export function buildAuthorizeUrl(opts: {
  state: string;
  redirectUri: string;
  schoolEmail: string;
}): string {
  const clientId = process.env.STRIPE_CLIENT_ID;
  if (!clientId) throw new Error('STRIPE_CLIENT_ID env var is required for OAuth Connect');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: 'read_write',
    redirect_uri: opts.redirectUri,
    state: opts.state,
    'stripe_user[email]': opts.schoolEmail,
  });
  return `https://connect.stripe.com/oauth/v2/authorize?${params.toString()}`;
}

export interface OAuthExchangeResult {
  stripeAccountId: string;     // the school's existing Stripe account id
  livemode: boolean;
}

// Exchange the authorization code for the school's stripe_user_id and
// persist into payment_accounts. Idempotent on (school_id): if a row
// exists, we UPDATE; otherwise INSERT. The school can re-connect to
// switch which of their Stripe accounts is linked, or to refresh after
// a revoke + re-authorize cycle.
export async function exchangeAndPersist(opts: {
  schoolId: string;
  code: string;
  connectedByEmail: string;
}): Promise<OAuthExchangeResult> {
  const s = stripe();
  const tok = await s.oauth.token({
    grant_type: 'authorization_code',
    code: opts.code,
  });
  if (!tok.stripe_user_id) {
    throw new Error('Stripe OAuth response missing stripe_user_id');
  }

  // Pull the connected account state once so the payment_accounts row
  // reflects reality from the start (charges_enabled / payouts_enabled
  // would otherwise stay false until the next account.updated webhook).
  const account = await s.accounts.retrieve(tok.stripe_user_id);

  await query(
    `INSERT INTO payment_accounts
       (school_id, stripe_account_id, stripe_account_type,
        connected_by_email, charges_enabled, payouts_enabled, details_submitted,
        requirements_currently_due, last_synced_at)
     VALUES ($1, $2, 'standard', $3, $4, $5, $6, $7::jsonb, now())
     ON CONFLICT (school_id) DO UPDATE SET
       stripe_account_id = EXCLUDED.stripe_account_id,
       connected_by_email = EXCLUDED.connected_by_email,
       charges_enabled = EXCLUDED.charges_enabled,
       payouts_enabled = EXCLUDED.payouts_enabled,
       details_submitted = EXCLUDED.details_submitted,
       requirements_currently_due = EXCLUDED.requirements_currently_due,
       last_synced_at = now(),
       updated_at = now()`,
    [
      opts.schoolId,
      tok.stripe_user_id,
      opts.connectedByEmail,
      account.charges_enabled,
      account.payouts_enabled,
      account.details_submitted,
      JSON.stringify(account.requirements?.currently_due ?? []),
    ],
  );

  return {
    stripeAccountId: tok.stripe_user_id,
    livemode: !!tok.livemode,
  };
}
