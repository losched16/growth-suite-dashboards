-- Payments Phase 4 — discounts engine.
--
-- A school can publish discount policies that automatically apply
-- against invoices that match a set of conditions. Two flavors:
--
--   AUTO discounts (kind='auto'):
--     Applied silently at invoice creation. e.g. "Multi-child sibling
--     discount: 10% off tuition for the 2nd+ child", or "Early-bird:
--     5% off enrollment paid before Apr 30".
--
--   CODE discounts (kind='code'):
--     Parent enters a code on the pay page to redeem. e.g. "WELCOME50".
--     Limited-use codes track per-family redemption count.
--
--   FA discounts (kind='financial_aid'):
--     Tied to a financial_aid_award row. The award amount becomes a
--     negative line item on every tuition invoice for the family until
--     the award balance is exhausted.

CREATE TABLE IF NOT EXISTS discount_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,

  kind text NOT NULL CHECK (kind IN ('auto', 'code', 'financial_aid')),
  display_name text NOT NULL,                       -- shown on invoice line item
  internal_note text,                                -- operator-only

  -- Discount math. Exactly one of percentage_bp or amount_cents must
  -- be non-zero. Percentages apply to the matching subtotal (after
  -- evaluating `applies_to`).
  percentage_basis_points int NOT NULL DEFAULT 0    -- 1000 = 10%
    CHECK (percentage_basis_points >= 0 AND percentage_basis_points <= 10000),
  amount_cents int NOT NULL DEFAULT 0
    CHECK (amount_cents >= 0),

  -- Optional cap so a percentage doesn't go runaway on a huge invoice.
  max_discount_cents int,

  -- What categories of line items does this discount apply to?
  -- NULL = applies to all line items.
  -- ['tuition'] = only tuition lines, etc.
  applies_to_categories text[] NOT NULL DEFAULT '{}',

  -- Conditions for auto-apply (kind='auto'). Examples:
  --   { "min_children_enrolled": 2 }                 ← sibling discount
  --   { "match_form_slug": "enrollment-deposit" }    ← only on this form
  --   { "submitted_before": "2026-04-30" }           ← early-bird window
  --   { "family_tag": "founders" }                   ← tagged families only
  conditions jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Redemption code (kind='code'). Case-insensitive unique within school.
  redemption_code text,
  -- Optional cap on total redemptions across the school.
  max_total_redemptions int,
  -- Optional cap on redemptions per family.
  max_redemptions_per_family int NOT NULL DEFAULT 1,
  -- How many times has this code been redeemed?
  redemption_count int NOT NULL DEFAULT 0,

  -- For 'financial_aid' kind: the fa_applications row this discount is
  -- sourced from. The award amount comes from
  -- fa_applications.recommended_award.
  fa_application_id uuid REFERENCES fa_applications(id) ON DELETE CASCADE,

  -- Activation window.
  active_from timestamptz,
  active_until timestamptz,
  is_active boolean NOT NULL DEFAULT true,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Code uniqueness per school (case-insensitive).
  UNIQUE (school_id, redemption_code)
);

CREATE INDEX IF NOT EXISTS idx_discount_policies_school_active
  ON discount_policies (school_id, is_active)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_discount_policies_kind
  ON discount_policies (school_id, kind, is_active);

-- ----- discount_applications --------------------------------------------
-- Audit trail of every discount applied to every invoice. One row per
-- (invoice, discount_policy). Used to enforce per-family caps, surface
-- the breakdown on the parent receipt, and decrement FA award balances.

CREATE TABLE IF NOT EXISTS discount_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  discount_policy_id uuid NOT NULL REFERENCES discount_policies(id) ON DELETE RESTRICT,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,

  amount_cents int NOT NULL,                       -- positive cents withheld
  applied_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (invoice_id, discount_policy_id)
);

CREATE INDEX IF NOT EXISTS idx_discount_apps_invoice
  ON discount_applications (invoice_id);
CREATE INDEX IF NOT EXISTS idx_discount_apps_family_policy
  ON discount_applications (family_id, discount_policy_id);

-- ----- invoices.discount_total_cents -----------------------------------
-- Stamp the total discount amount on the invoice so we don't have to
-- re-aggregate every read. The invoice_line_items table already supports
-- negative line items (no CHECK constraint blocks it).

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS discount_total_cents int NOT NULL DEFAULT 0;

-- updated_at trigger for discount_policies (reuses the generic
-- portal_form_defs_touch_updated_at() function from migration 013,
-- which just sets NEW.updated_at = now()).
DROP TRIGGER IF EXISTS discount_policies_touch ON discount_policies;
CREATE TRIGGER discount_policies_touch
  BEFORE UPDATE ON discount_policies
  FOR EACH ROW EXECUTE FUNCTION portal_form_defs_touch_updated_at();

COMMENT ON TABLE discount_policies IS
  'Per-school discount rules: auto-apply (sibling, early-bird), redeemable codes, or FA awards.';
COMMENT ON TABLE discount_applications IS
  'Audit row recording one discount applied to one invoice. Enforces per-family redemption caps.';
