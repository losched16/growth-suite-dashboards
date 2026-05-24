-- Audit + idempotency record of every Stripe webhook event we've
-- processed. The webhook handler INSERT...ON CONFLICT(event_id) DO
-- NOTHING means duplicate deliveries from Stripe are no-ops.
--
-- Retention: we keep everything for now. Add a retention policy when
-- this table gets large (probably a few million rows in).

CREATE TABLE IF NOT EXISTS stripe_webhook_log (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  payload jsonb,
  processed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_log_type_time
  ON stripe_webhook_log (event_type, processed_at DESC);
