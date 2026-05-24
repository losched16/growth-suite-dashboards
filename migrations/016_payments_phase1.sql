-- Payments Phase 1 — foundation tables for Stripe Connect + tuition config.
--
-- Tenant model: every table is school_id-scoped. Multi-tenant from day one.
-- We never store credit-card numbers ourselves — Stripe holds the
-- PaymentMethods and we only persist Stripe IDs.
--
-- Money flow:
--   Parent pays $X via Stripe (PaymentIntent on platform account, with
--   application_fee_amount routing $25 to the platform). $X-$25 settles
--   directly into the school's connected Stripe account. Growth Suite
--   never touches the money or holds a balance.
--
-- All amounts stored as INTEGER cents (avoid float precision bugs).

-- ----- payment_accounts -----------------------------------------------
-- One row per school = one Stripe Connect (Standard) account.
-- Created when the school admin clicks "Connect Stripe" in the admin UI.
-- We keep the connected account id, the onboarding status, and Stripe's
-- charges_enabled / payouts_enabled flags so we know when the school is
-- actually ready to accept payments.
CREATE TABLE IF NOT EXISTS payment_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,

  stripe_account_id text NOT NULL,             -- 'acct_1AbC...'
  stripe_account_type text NOT NULL            -- 'standard'/'express'/'custom'
    DEFAULT 'standard' CHECK (stripe_account_type IN ('standard','express','custom')),

  -- Onboarding state mirrored from Stripe so we can show the operator
  -- exactly where the school is.
  charges_enabled boolean NOT NULL DEFAULT false,
  payouts_enabled boolean NOT NULL DEFAULT false,
  details_submitted boolean NOT NULL DEFAULT false,
  requirements_currently_due jsonb,             -- raw from Stripe Accounts API

  -- Bookkeeping
  connected_by_email text,                      -- school staffer who connected
  connected_at timestamptz NOT NULL DEFAULT now(),
  last_synced_at timestamptz,
  disconnected_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- One active connection per school. If a school re-connects they reuse
  -- the same row (UPDATE) — we never create duplicates.
  UNIQUE (school_id)
);

CREATE INDEX IF NOT EXISTS idx_payment_accounts_stripe
  ON payment_accounts (stripe_account_id);

-- ----- school_payment_config ------------------------------------------
-- Per-school billing policy. One row per school. Sets the rules for
-- every charge: fee pass-through, allowed payment days, late-fee policy,
-- platform-fee labeling, etc.
CREATE TABLE IF NOT EXISTS school_payment_config (
  school_id uuid PRIMARY KEY REFERENCES schools(id) ON DELETE CASCADE,

  -- Fee pass-through (per rail). When true: parent pays the fee on top
  -- of the base amount. When false: school absorbs the fee and parent
  -- pays exactly the base amount.
  pass_card_fee boolean NOT NULL DEFAULT true,
  pass_ach_fee  boolean NOT NULL DEFAULT false,

  -- Display label parents see when a fee is being passed through.
  -- Defaults to "Processing fee" but schools can re-label (e.g. some
  -- prefer "Convenience fee").
  processing_fee_label text NOT NULL DEFAULT 'Processing fee',

  -- Allowed days of the month for autopay. INT array, 1-28.
  -- e.g. [1, 15] means autopay always lands on the 1st or 15th.
  -- 28-day cap is intentional — guarantees the day exists in every month.
  autopay_days int[] NOT NULL DEFAULT ARRAY[1, 15],

  -- Late-fee policy
  late_fee_amount_cents int NOT NULL DEFAULT 0,    -- 0 = none
  late_fee_grace_days int NOT NULL DEFAULT 3,

  -- Failed-payment retry schedule (days after failure)
  retry_schedule_days int[] NOT NULL DEFAULT ARRAY[1, 3, 7],

  -- Statement / invoice numbering
  invoice_number_prefix text NOT NULL DEFAULT 'INV',
  next_invoice_number int NOT NULL DEFAULT 1,

  -- Misc
  default_currency text NOT NULL DEFAULT 'usd',
  ach_enabled boolean NOT NULL DEFAULT true,
  card_enabled boolean NOT NULL DEFAULT true,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ----- tuition_grids --------------------------------------------------
-- Per-school list of tuition levels (one per grade or program).
-- The tuition_calculator form field looks these up by program/grade to
-- show parents the right starting amount before adjustments.
CREATE TABLE IF NOT EXISTS tuition_grids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,

  academic_year text NOT NULL,                      -- e.g. '2026-27'
  program text NOT NULL,                            -- e.g. 'Preschool', 'Kindergarten'
  grade_level text,                                 -- optional sub-bucket
  display_name text NOT NULL,                       -- what parents see

  annual_tuition_cents int NOT NULL,                -- base amount before plan/add-ons

  -- Optional add-ons offered for this program (json array of {label,
  -- amount_cents, key}). Parents check boxes; calculator sums them in.
  -- e.g. [{key:'before_care', label:'Before Care', amount_cents: 80000}]
  addons jsonb NOT NULL DEFAULT '[]'::jsonb,

  is_active boolean NOT NULL DEFAULT true,
  position int NOT NULL DEFAULT 0,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (school_id, academic_year, program, grade_level)
);

CREATE INDEX IF NOT EXISTS idx_tuition_grids_school_year
  ON tuition_grids (school_id, academic_year, is_active);

-- ----- payment_plans --------------------------------------------------
-- Per-school list of payment-plan templates parents can choose from.
-- (Annual, 2-pay, 10-pay, etc.) The school defines them; the parent
-- picks one at enrollment time.
CREATE TABLE IF NOT EXISTS payment_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,

  slug text NOT NULL,                               -- 'annual', '2-pay', '10-pay'
  display_name text NOT NULL,                       -- 'Annual (single payment)'
  description text,

  installment_count int NOT NULL,                   -- 1 for annual, 2, 10, etc.

  -- Optional discount applied for choosing this plan (e.g. annual-pay
  -- discount). Stored as basis points: 250 = 2.5%.
  discount_basis_points int NOT NULL DEFAULT 0,

  -- Schedule: how Future installments are placed. JSON describing the
  -- recurrence. For v1:
  --   {"kind":"single"}                              — single annual payment
  --   {"kind":"monthly","months":["08","09",...,"05"]} — 10 months
  --   {"kind":"semiannual","months":["08","01"]}    — 2 payments per year
  --   {"kind":"custom","dates":["2026-08-15","2027-01-15"]}
  schedule_template jsonb NOT NULL,

  is_active boolean NOT NULL DEFAULT true,
  position int NOT NULL DEFAULT 0,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (school_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_payment_plans_school
  ON payment_plans (school_id, is_active, position);

-- ----- families.platform_setup_fee_paid_at ----------------------------
-- Track that the one-time $25 Growth Suite setup fee has been collected
-- for this family. We charge it once per (school, family) — on the
-- first tuition-related payment. Future payments don't re-trigger it.
ALTER TABLE families
  ADD COLUMN IF NOT EXISTS platform_setup_fee_paid_at timestamptz;

-- updated_at triggers (reuse existing portal_form_defs_touch fn)
DROP TRIGGER IF EXISTS payment_accounts_touch ON payment_accounts;
CREATE TRIGGER payment_accounts_touch
  BEFORE UPDATE ON payment_accounts
  FOR EACH ROW EXECUTE FUNCTION portal_form_defs_touch_updated_at();

DROP TRIGGER IF EXISTS school_payment_config_touch ON school_payment_config;
CREATE TRIGGER school_payment_config_touch
  BEFORE UPDATE ON school_payment_config
  FOR EACH ROW EXECUTE FUNCTION portal_form_defs_touch_updated_at();

DROP TRIGGER IF EXISTS tuition_grids_touch ON tuition_grids;
CREATE TRIGGER tuition_grids_touch
  BEFORE UPDATE ON tuition_grids
  FOR EACH ROW EXECUTE FUNCTION portal_form_defs_touch_updated_at();

DROP TRIGGER IF EXISTS payment_plans_touch ON payment_plans;
CREATE TRIGGER payment_plans_touch
  BEFORE UPDATE ON payment_plans
  FOR EACH ROW EXECUTE FUNCTION portal_form_defs_touch_updated_at();
