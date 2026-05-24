// Stripe API client for the dashboards (admin) app.
//
// We use a single platform-level Stripe key (STRIPE_SECRET_KEY). All
// per-school operations are performed *on behalf of* the school's
// connected account by passing `stripeAccount` on the request — Stripe
// handles the routing.
//
// Env vars:
//   STRIPE_SECRET_KEY      sk_test_... (or sk_live_...)
//   STRIPE_WEBHOOK_SECRET  whsec_... (set after webhook is registered)
//   STRIPE_PLATFORM_NAME   Display name in onboarding flows. Default "Growth Suite".

import Stripe from 'stripe';

let _stripe: Stripe | undefined;

export function stripe(): Stripe {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY env var is required');
  _stripe = new Stripe(key, {
    // Pin the API version so Stripe SDK changes don't surprise us.
    apiVersion: '2026-04-22.dahlia',
    typescript: true,
  });
  return _stripe;
}

export function platformName(): string {
  return process.env.STRIPE_PLATFORM_NAME || 'Growth Suite';
}
