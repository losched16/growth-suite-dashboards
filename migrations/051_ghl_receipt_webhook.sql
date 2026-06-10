-- 051_ghl_receipt_webhook.sql
--
-- Route payment receipts through GoHighLevel instead of (or alongside)
-- Resend. The school builds an email in their GHL workflow builder using
-- their own template + merge fields; we just fire an inbound-webhook
-- trigger with the payment data on success/failure.
--
-- One URL handles both events — the payload carries an `event` field
-- ('payment.succeeded' | 'payment.failed') the school branches on inside
-- their workflow. NULL = no GHL routing (falls back to Resend email if
-- RESEND_API_KEY is configured; otherwise no receipt).

BEGIN;

ALTER TABLE school_payment_config
  ADD COLUMN IF NOT EXISTS ghl_receipt_webhook_url text;

COMMENT ON COLUMN school_payment_config.ghl_receipt_webhook_url IS
  'GHL workflow inbound-webhook URL. When set, payment receipt/failure events POST here so the school owns the email template in GHL. NULL = use Resend fallback.';

COMMIT;
