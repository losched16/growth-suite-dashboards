// Stripe Connect Standard onboarding for a school.
//
// Flow:
//   1) Operator clicks "Connect Stripe" on /admin/{schoolId}/payments.
//   2) Server-side: create (or fetch existing) Stripe Account, then create
//      an Account Link with type=account_onboarding.
//   3) We redirect the operator to the Account Link URL.
//   4) Stripe walks them through KYC. On completion they're returned to
//      `return_url`. On refresh (timeout / interruption) Stripe sends
//      them to `refresh_url` and we generate a new link.
//   5) `account.updated` webhook fires; we sync `charges_enabled` /
//      `payouts_enabled` / `details_submitted` into payment_accounts.
//
// Idempotent: if the school already has a payment_accounts row, we reuse
// the existing stripe_account_id instead of creating a new account.

import { query } from '@/lib/db';
import { stripe, platformName } from './client';

interface BeginOnboardingArgs {
  schoolId: string;
  schoolName: string;
  schoolEmail: string;           // who's connecting (for audit/contact)
  operatorEmail: string;          // who clicked the button
  returnBaseUrl: string;          // e.g. https://growth-suite-dashboards.vercel.app/admin/<id>/payments
}

export interface OnboardingResult {
  accountId: string;
  onboardingUrl: string;
  isNewAccount: boolean;
}

export async function beginConnectOnboarding(args: BeginOnboardingArgs): Promise<OnboardingResult> {
  const s = stripe();

  // 1) Find or create the Stripe Account for this school.
  const { rows: existing } = await query<{ stripe_account_id: string }>(
    `SELECT stripe_account_id FROM payment_accounts WHERE school_id = $1`,
    [args.schoolId],
  );

  let accountId: string;
  let isNewAccount = false;
  if (existing.length > 0) {
    accountId = existing[0].stripe_account_id;
  } else {
    const account = await s.accounts.create({
      type: 'standard',
      country: 'US',
      email: args.schoolEmail,
      business_profile: {
        name: args.schoolName,
        product_description: 'K-12 school tuition, fees, and event payments',
        // Identifier visible to the school in their Stripe dashboard
        // so they understand who connected them.
      },
      metadata: {
        school_id: args.schoolId,
        platform: platformName(),
        connected_by: args.operatorEmail,
      },
    });
    accountId = account.id;
    isNewAccount = true;

    // Persist the row immediately so a refresh during onboarding finds it.
    await query(
      `INSERT INTO payment_accounts
         (school_id, stripe_account_id, stripe_account_type,
          connected_by_email, charges_enabled, payouts_enabled, details_submitted)
       VALUES ($1, $2, 'standard', $3, false, false, false)
       ON CONFLICT (school_id) DO UPDATE SET
         stripe_account_id = EXCLUDED.stripe_account_id,
         connected_by_email = EXCLUDED.connected_by_email,
         updated_at = now()`,
      [args.schoolId, accountId, args.operatorEmail],
    );
  }

  // 2) Create an Account Link for the onboarding flow.
  const link = await s.accountLinks.create({
    account: accountId,
    refresh_url: `${args.returnBaseUrl}?stripe=refresh`,
    return_url: `${args.returnBaseUrl}?stripe=return`,
    type: 'account_onboarding',
  });

  return {
    accountId,
    onboardingUrl: link.url,
    isNewAccount,
  };
}

// Pull the latest state from Stripe and persist it. Called from the
// webhook handler on `account.updated` and from the admin page on
// stripe=return so the operator sees a fresh status without waiting
// for the webhook to land.
export async function syncStripeAccountState(stripeAccountId: string): Promise<void> {
  const s = stripe();
  const account = await s.accounts.retrieve(stripeAccountId);

  await query(
    `UPDATE payment_accounts
        SET charges_enabled = $1,
            payouts_enabled = $2,
            details_submitted = $3,
            requirements_currently_due = $4::jsonb,
            last_synced_at = now(),
            updated_at = now()
      WHERE stripe_account_id = $5`,
    [
      account.charges_enabled,
      account.payouts_enabled,
      account.details_submitted,
      JSON.stringify(account.requirements?.currently_due ?? []),
      stripeAccountId,
    ],
  );
}

export async function loadPaymentAccount(schoolId: string): Promise<{
  stripe_account_id: string;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  requirements_currently_due: string[] | null;
  last_synced_at: Date | null;
} | null> {
  const { rows } = await query<{
    stripe_account_id: string;
    charges_enabled: boolean;
    payouts_enabled: boolean;
    details_submitted: boolean;
    requirements_currently_due: string[] | null;
    last_synced_at: Date | null;
  }>(
    `SELECT stripe_account_id, charges_enabled, payouts_enabled,
            details_submitted, requirements_currently_due, last_synced_at
       FROM payment_accounts WHERE school_id = $1`,
    [schoolId],
  );
  return rows[0] ?? null;
}
