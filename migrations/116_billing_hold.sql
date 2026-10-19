-- School billing hold: pause all automatic charging and late fees for a
-- date window (inclusive), per school.
--
-- Used when a school moves billing to another system for a period (Northern
-- Lights Montessori, November 2026: "I don't want anyone charged"). Enforced
-- by the parent portal's autopay cron, its autopay-on-card-attach path, the
-- charge function itself, and the nightly late-fee pass.
--
-- While today is inside the window, nothing is charged and no late fee
-- accrues. Invoices whose charge date (autopay_charge_on, else due_at) falls
-- inside the window are also never auto-charged or fee'd after it closes, so
-- lifting the hold does not bill the skipped installments.
--
-- Both NULL (the default) means no hold. To lift early:
--   UPDATE school_payment_config SET billing_hold_from = NULL, billing_hold_until = NULL
--    WHERE school_id = '<school id>';
--
-- Apply this migration BEFORE deploying the parent portal change: the portal
-- queries these columns and the cron would error without them.

ALTER TABLE school_payment_config
  ADD COLUMN IF NOT EXISTS billing_hold_from  date NULL,
  ADD COLUMN IF NOT EXISTS billing_hold_until date NULL;

COMMENT ON COLUMN school_payment_config.billing_hold_from IS
  'First day (inclusive) of a school-wide billing hold. NULL = no hold. See migration 116.';
COMMENT ON COLUMN school_payment_config.billing_hold_until IS
  'Last day (inclusive) of a school-wide billing hold. NULL = no hold. See migration 116.';

-- Northern Lights Montessori Academy: November 2026 (new billing system).
UPDATE school_payment_config
   SET billing_hold_from  = DATE '2026-11-01',
       billing_hold_until = DATE '2026-11-30',
       updated_at = now()
 WHERE school_id = '2717d71b-aa80-4ca0-8a13-e81cace2d9c1';
