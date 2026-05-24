-- Add per-school fee fields that weren't previously surfaced. Schools
-- specify these in their enrollment agreement (plan-change fee,
-- withdrawal fee), but our config table didn't have a home for them.
-- Default 0 so existing schools aren't billed any of these by accident.

ALTER TABLE school_payment_config
  ADD COLUMN IF NOT EXISTS plan_change_fee_cents integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS withdrawal_fee_cents  integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS withdrawal_notice_days integer NOT NULL DEFAULT 30;

COMMENT ON COLUMN school_payment_config.plan_change_fee_cents IS
  'Fee charged when a family switches payment plans mid-year (e.g. DGM: $30).';
COMMENT ON COLUMN school_payment_config.withdrawal_fee_cents IS
  'Voluntary-withdrawal fee. Separate from tuition obligation through notice period (e.g. DGM: $2000).';
COMMENT ON COLUMN school_payment_config.withdrawal_notice_days IS
  'Days of written notice required for voluntary withdrawal (default 30).';
