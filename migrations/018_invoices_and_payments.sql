-- Payments Phase 1c — invoices + payments + stored payment methods.
--
-- Model:
--   invoice           — what's owed (header)
--   invoice_line_item — itemized lines on the invoice
--   payment           — an attempt to pay (1+ per invoice, only one
--                       succeeds; failed attempts kept for audit)
--   payment_method    — a parent's stored card or bank for autopay /
--                       fast re-payments. Stripe holds the actual
--                       sensitive data; we only persist Stripe IDs.
--
-- Money: every amount is INTEGER cents.
--
-- Invoice flow:
--   draft → open (sent to parent) → paid | partially_paid | voided
--   `paid` can lead to `refunded` (full) or `partially_refunded`.

-- ----- invoices -------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  student_id uuid REFERENCES students(id) ON DELETE SET NULL,    -- null for family-level invoices

  -- Human-friendly number, e.g. "INV-000123". Derived from
  -- school_payment_config.invoice_number_prefix + next_invoice_number.
  invoice_number text NOT NULL,

  -- Title shown on the invoice + status tracking
  title text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','open','paid','partially_paid','voided','refunded','partially_refunded')),

  -- Money. subtotal = sum of line items. processing_fee_cents = the
  -- card / ACH fee if pass-through is on. platform_fee_cents = the $25
  -- family setup fee if applicable. total = subtotal + both fees.
  subtotal_cents int NOT NULL DEFAULT 0,
  processing_fee_cents int NOT NULL DEFAULT 0,
  platform_fee_cents int NOT NULL DEFAULT 0,
  total_cents int NOT NULL DEFAULT 0,
  amount_paid_cents int NOT NULL DEFAULT 0,

  currency text NOT NULL DEFAULT 'usd',

  -- Lifecycle dates
  issued_at timestamptz,                         -- when status moved draft → open
  due_at timestamptz NOT NULL,
  paid_at timestamptz,
  voided_at timestamptz,
  voided_reason text,

  -- Source — what created this invoice. Free-form for now; later we'll
  -- enum it. Examples: 'manual', 'form_submission', 'tuition_plan',
  -- 'enrollment_deposit'.
  source text NOT NULL DEFAULT 'manual',
  source_ref jsonb,                              -- IDs of related rows in source system

  -- Per-invoice notes (admin-only)
  internal_note text,

  -- If this invoice represents the family's first plan-setup payment,
  -- the $25 platform fee is charged here. After success, we stamp
  -- families.platform_setup_fee_paid_at and never charge again.
  includes_platform_setup_fee boolean NOT NULL DEFAULT false,

  created_by_email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (school_id, invoice_number)
);

CREATE INDEX IF NOT EXISTS idx_invoices_family ON invoices (school_id, family_id, status);
CREATE INDEX IF NOT EXISTS idx_invoices_due ON invoices (school_id, status, due_at) WHERE status = 'open';

-- ----- invoice_line_items --------------------------------------------
CREATE TABLE IF NOT EXISTS invoice_line_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,

  position int NOT NULL DEFAULT 0,
  description text NOT NULL,
  quantity int NOT NULL DEFAULT 1,
  unit_amount_cents int NOT NULL,
  amount_cents int NOT NULL,                     -- = quantity * unit_amount_cents

  -- Optional: which student this line is for (a single invoice may have
  -- per-student lines for sibling families with one combined bill).
  student_id uuid REFERENCES students(id) ON DELETE SET NULL,

  -- Optional: category for reporting ('tuition','enrollment_deposit',
  -- 'lunch','event_ticket','field_trip','late_fee','other')
  category text,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invoice_line_items_invoice
  ON invoice_line_items (invoice_id, position);

-- ----- payments -------------------------------------------------------
-- One row per Stripe PaymentIntent attempt. An invoice may have
-- multiple payment rows (failed, then succeeded). Status follows
-- Stripe's PaymentIntent status closely.
CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  invoice_id uuid REFERENCES invoices(id) ON DELETE SET NULL,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,

  -- Stripe linkage
  stripe_payment_intent_id text UNIQUE,
  stripe_charge_id text,
  stripe_payment_method_id text,
  stripe_payment_method_type text,               -- 'card' / 'us_bank_account'

  -- Money breakdown
  amount_cents int NOT NULL,                     -- what the parent was charged
  fee_cents int NOT NULL DEFAULT 0,              -- processing fee paid (informational)
  platform_fee_cents int NOT NULL DEFAULT 0,     -- application_fee_amount routed to us
  destination_amount_cents int,                  -- what the school received (gross - platform_fee)

  -- Lifecycle
  status text NOT NULL                           -- 'pending'/'processing'/'succeeded'/'failed'/'refunded'
    CHECK (status IN ('pending','processing','succeeded','failed','refunded','partially_refunded')),
  failure_code text,
  failure_message text,

  paid_by_parent_id uuid REFERENCES parents(id) ON DELETE SET NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payments_family ON payments (family_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments (invoice_id, status);

-- ----- payment_methods (stored cards / bank accounts) ----------------
-- Reference to the parent's saved payment methods in Stripe. We never
-- store the card/bank details — only Stripe IDs + display hints (last
-- 4 digits, brand) so the parent can recognize them in the UI.
CREATE TABLE IF NOT EXISTS payment_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  added_by_parent_id uuid REFERENCES parents(id) ON DELETE SET NULL,

  stripe_payment_method_id text NOT NULL,
  stripe_customer_id text NOT NULL,              -- attached to the school's connected account

  type text NOT NULL CHECK (type IN ('card','us_bank_account')),
  -- Display hints (safe to store + show)
  brand text,                                    -- 'visa','mastercard',etc. or bank name
  last4 text,
  exp_month int,                                 -- card only
  exp_year int,                                  -- card only

  is_default boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (school_id, stripe_payment_method_id)
);

CREATE INDEX IF NOT EXISTS idx_payment_methods_family
  ON payment_methods (family_id, active, is_default DESC);

-- ----- families.stripe_customer_id ------------------------------------
-- Cache the Stripe Customer ID created on the school's connected
-- account for this family. One Customer per (school, family). Created
-- lazily on first payment.
ALTER TABLE families
  ADD COLUMN IF NOT EXISTS stripe_customer_ids jsonb NOT NULL DEFAULT '{}'::jsonb;
-- Shape: { "<school_id>": "cus_..." }

-- updated_at triggers
DROP TRIGGER IF EXISTS invoices_touch ON invoices;
CREATE TRIGGER invoices_touch BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION portal_form_defs_touch_updated_at();

DROP TRIGGER IF EXISTS payments_touch ON payments;
CREATE TRIGGER payments_touch BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION portal_form_defs_touch_updated_at();

DROP TRIGGER IF EXISTS payment_methods_touch ON payment_methods;
CREATE TRIGGER payment_methods_touch BEFORE UPDATE ON payment_methods
  FOR EACH ROW EXECUTE FUNCTION portal_form_defs_touch_updated_at();
