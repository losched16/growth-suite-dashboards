-- DGM enrollment fee + payment-plan modifiers + platform-fee waiver.
--
-- Per-school config so each school can set its own:
--   - Enrollment fee cutoff date + before/after amounts
--   - Monthly plan administrative fee (% of tuition)
--   - Annual plan discount (% of tuition)
--   - Whether to charge our $25 platform setup fee at all
--
-- DGM specifics from their Enrollment Agreement 2026-27:
--   - Cutoff: 2026-01-31 (≤ = $395, > = $595)
--   - Monthly plan: +3% admin fee on annual tuition
--   - Annual plan: -5% discount on annual tuition (not stackable with sibling)
--   - Waive Growth Suite's $25 platform family setup fee

ALTER TABLE school_payment_config
  ADD COLUMN IF NOT EXISTS waive_platform_setup_fee boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS enrollment_fee_cutoff_date date,
  ADD COLUMN IF NOT EXISTS enrollment_fee_early_cents int,
  ADD COLUMN IF NOT EXISTS enrollment_fee_late_cents int,
  ADD COLUMN IF NOT EXISTS monthly_plan_admin_fee_bp int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS annual_plan_discount_bp int NOT NULL DEFAULT 0;

-- Configure DGM
UPDATE school_payment_config
   SET waive_platform_setup_fee = true,
       enrollment_fee_cutoff_date = DATE '2026-01-31',
       enrollment_fee_early_cents = 39500,    -- $395
       enrollment_fee_late_cents  = 59500,    -- $595
       monthly_plan_admin_fee_bp  = 300,      -- +3%
       annual_plan_discount_bp    = 500       -- -5%
 WHERE school_id = 'cfa9030d-c8fe-49ae-a9e7-f1003844ec07';

-- If DGM's config row doesn't exist yet, create one with the defaults
INSERT INTO school_payment_config (
  school_id,
  waive_platform_setup_fee,
  enrollment_fee_cutoff_date,
  enrollment_fee_early_cents,
  enrollment_fee_late_cents,
  monthly_plan_admin_fee_bp,
  annual_plan_discount_bp
)
VALUES (
  'cfa9030d-c8fe-49ae-a9e7-f1003844ec07',
  true,
  DATE '2026-01-31',
  39500,
  59500,
  300,
  500
)
ON CONFLICT (school_id) DO NOTHING;

COMMENT ON COLUMN school_payment_config.waive_platform_setup_fee IS
  'When TRUE, invoices for this school skip the one-time $25 Growth Suite family setup fee. Used for grandfathered schools.';
COMMENT ON COLUMN school_payment_config.enrollment_fee_cutoff_date IS
  'Date that separates the early vs late enrollment fee. Enrollment fees signed on or before this date pay enrollment_fee_early_cents; after pay enrollment_fee_late_cents.';
