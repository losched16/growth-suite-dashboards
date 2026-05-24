-- Product catalog: anything a school wants to charge for that ISN'T
-- annual tuition. Examples: event tickets, fundraiser donations,
-- field trips, supplies, photo packages, recurring after-school
-- activities, monthly lunch (for schools where lunch is a la carte).
--
-- Three product types in one table — discriminated by `product_type`:
--   - one_time      : flat-price charge
--   - recurring     : Stripe subscription (monthly/yearly)
--   - donation      : variable amount, optional suggested values
--
-- Each product can be sold via:
--   - Parent portal (logged-in parent browses school products)
--   - Public hosted payment link (shared in GHL forms, emails, social)
--
-- All charges flow through the SCHOOL's Stripe Connect account
-- (same pattern as tuition invoices). Multi-tenant from day one.

CREATE TABLE IF NOT EXISTS school_products (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id       uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,

  -- URL slug for the hosted payment link. Unique per school. Schools
  -- pick a friendly slug like "spring-fundraiser" or "field-trip-may".
  slug            text NOT NULL,

  -- Display
  name            text NOT NULL,
  description     text,
  category        text,                 -- 'event' | 'donation' | 'supplies' | 'tuition_addon' | 'other' (free text)
  image_url       text,

  -- Type discriminator
  product_type    text NOT NULL CHECK (product_type IN ('one_time', 'recurring', 'donation')),

  -- Price (one_time + recurring only — donation uses suggested_amounts)
  price_cents     integer,

  -- DONATION-specific
  -- Suggested amounts in cents, e.g. [2500, 5000, 10000, 25000] for $25/$50/$100/$250.
  -- Donor can pick a suggested amount or enter their own.
  suggested_amounts_cents integer[],
  donation_min_cents      integer,      -- minimum allowed donation (default 100 = $1)

  -- RECURRING-specific
  recurring_interval        text CHECK (recurring_interval IN ('month', 'year')),
  recurring_installment_count integer,   -- total # of installments (e.g. 10 for monthly lunch over year). NULL = forever
  recurring_first_charge_date date,      -- when to start charging (defaults to immediately on purchase)

  -- Per-student or family-level?
  per_student         boolean NOT NULL DEFAULT false,
  max_quantity        integer,          -- max qty per purchase (e.g., 6 tickets max). NULL = unlimited

  -- Availability
  available_to        text NOT NULL DEFAULT 'both' CHECK (available_to IN ('parents', 'public', 'both')),
  available_from      timestamptz,
  available_until     timestamptz,

  -- Stripe — created lazily on first purchase (or via "Sync to Stripe" action)
  stripe_product_id   text,             -- Stripe Product ID on school's connected account
  stripe_price_id     text,             -- Stripe Price ID (for one_time + recurring)

  -- GHL integration
  ghl_writeback_field text,             -- optional custom field key to flag when purchased
  ghl_workflow_id     text,             -- optional GHL workflow to trigger on purchase

  -- Lifecycle
  is_active           boolean NOT NULL DEFAULT true,
  position            integer NOT NULL DEFAULT 0,
  internal_note       text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  -- Each school's slugs must be unique among that school's products
  UNIQUE (school_id, slug)
);

CREATE INDEX IF NOT EXISTS school_products_by_school    ON school_products (school_id);
CREATE INDEX IF NOT EXISTS school_products_by_active    ON school_products (school_id, is_active);

COMMENT ON TABLE school_products IS
  'Generic product catalog. Schools sell anything here — events, donations, recurring services. Tuition lives in tuition_grids / family_tuition_enrollments separately.';

-- ─── PURCHASES ────────────────────────────────────────────────────────
-- One row per completed (or attempted) purchase. Both portal-based and
-- public hosted-link purchases land here.

CREATE TABLE IF NOT EXISTS product_purchases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id       uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  product_id      uuid NOT NULL REFERENCES school_products(id) ON DELETE RESTRICT,

  -- Who bought it. Two scenarios:
  --   1. Logged-in parent → family_id + student_id (if per-student)
  --   2. Public link (e.g. via GHL form) → purchaser_email + name,
  --      we look up/create the GHL contact
  family_id       uuid REFERENCES families(id) ON DELETE SET NULL,
  student_id      uuid REFERENCES students(id) ON DELETE SET NULL,
  purchaser_email text,
  purchaser_name  text,
  purchaser_phone text,
  ghl_contact_id  text,                 -- GHL contact id (looked up by email or created)

  -- Money
  quantity        integer NOT NULL DEFAULT 1,
  unit_amount_cents integer NOT NULL,   -- price per unit at time of purchase
  total_amount_cents integer NOT NULL,  -- quantity × unit_amount

  -- Stripe
  stripe_payment_intent_id text,        -- for one_time + donation
  stripe_subscription_id   text,        -- for recurring
  stripe_charge_id         text,        -- after charge succeeds

  -- Status
  status          text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'succeeded', 'failed', 'canceled', 'refunded')),

  -- Provenance: where did this purchase originate?
  source          text NOT NULL DEFAULT 'portal'
    CHECK (source IN ('portal', 'hosted_link', 'ghl_form', 'admin_manual')),
  source_ref      text,                 -- e.g. GHL form submission ID, original URL params

  -- Network context (for fraud / debugging)
  ip_address      text,
  user_agent      text,

  -- Refund / void tracking
  refunded_at     timestamptz,
  refunded_amount_cents integer NOT NULL DEFAULT 0,
  refund_reason   text,

  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_purchases_by_school    ON product_purchases (school_id, created_at DESC);
CREATE INDEX IF NOT EXISTS product_purchases_by_product   ON product_purchases (product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS product_purchases_by_family    ON product_purchases (family_id) WHERE family_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS product_purchases_by_email     ON product_purchases (school_id, lower(purchaser_email));
CREATE INDEX IF NOT EXISTS product_purchases_by_stripe_pi ON product_purchases (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS product_purchases_by_stripe_sub ON product_purchases (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;

COMMENT ON TABLE product_purchases IS
  'Single-row record of any product purchase. Used for reporting, refunds, GHL writeback, and dashboard display.';
