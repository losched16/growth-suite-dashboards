-- Beef up stripe_webhook_log so it's actually useful at 100-school
-- scale. Today the table records only event_id + type + payload + a
-- processed_at timestamp — fine for replay, but if something breaks
-- you can't see which school it happened to, what the error was, or
-- whether we even got far enough to attempt processing.
--
-- New columns:
--   school_id           — best-effort match by stripe account id; NULL
--                         when the event isn't tied to a connected
--                         account yet (e.g. early account.updated for
--                         a brand-new connection).
--   stripe_account_id   — event.account from Stripe (the connected
--                         account that owns the event). Lets us look
--                         up which school this is even when the
--                         school_id can't be resolved.
--   livemode            — was the event from live or test Stripe?
--                         Helps diagnose "schools see fake charges"
--                         confusion when the platform is mid-flip.
--   status              — 'received' | 'processed' | 'failed'. Set
--                         to 'received' on insert, then updated.
--   error_message       — populated when status='failed'. Truncated
--                         to 2000 chars; full payload still in payload.
--   stripe_created_at   — event.created from Stripe so we can sort
--                         by Stripe's clock, not ours (handler delay
--                         can be material).
--   received_at         — when WE got the event (different from
--                         processed_at, which is when we finished).

ALTER TABLE stripe_webhook_log
  ADD COLUMN IF NOT EXISTS school_id          uuid NULL REFERENCES schools(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS stripe_account_id  text NULL,
  ADD COLUMN IF NOT EXISTS livemode           boolean NULL,
  ADD COLUMN IF NOT EXISTS status             text NOT NULL DEFAULT 'received',
  ADD COLUMN IF NOT EXISTS error_message      text NULL,
  ADD COLUMN IF NOT EXISTS stripe_created_at  timestamp with time zone NULL,
  ADD COLUMN IF NOT EXISTS received_at        timestamp with time zone NOT NULL DEFAULT now();

-- Indexes for the admin viewer's common filters.
CREATE INDEX IF NOT EXISTS idx_stripe_webhook_log_school        ON stripe_webhook_log(school_id);
CREATE INDEX IF NOT EXISTS idx_stripe_webhook_log_account       ON stripe_webhook_log(stripe_account_id);
CREATE INDEX IF NOT EXISTS idx_stripe_webhook_log_status        ON stripe_webhook_log(status);
CREATE INDEX IF NOT EXISTS idx_stripe_webhook_log_received_desc ON stripe_webhook_log(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_stripe_webhook_log_event_type    ON stripe_webhook_log(event_type);

COMMENT ON COLUMN stripe_webhook_log.status IS
  'received: insert sentinel (we got the event, signature verified). processed: handler completed without throwing. failed: handler threw — error_message populated.';

COMMENT ON COLUMN stripe_webhook_log.school_id IS
  'Resolved by joining stripe_account_id to payment_accounts.stripe_account_id. NULL when the event predates our knowledge of that account (very rare; typically only the FIRST account.updated for a brand-new connect).';
