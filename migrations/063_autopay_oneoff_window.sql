-- Per-school auto-bill window for ONE-OFF (incidental) invoices.
--
-- When set to N, any new one-off invoice (source='manual') that is issued
-- to a family with a saved card is scheduled to auto-charge N days after it
-- hits the parent portal (autopay_charge_on = issued + N). The existing
-- daily autopay cron performs the charge (and only once billing_active=true,
-- so dry-run schools never charge). NULL = feature off (default) — leaves
-- every other school's behavior unchanged; one-offs stay manual-pay.
--
-- DGM agreement: all new one-off invoices auto-bill within 5 days when a
-- card is on file → DGM gets 5.

ALTER TABLE school_payment_config
  ADD COLUMN IF NOT EXISTS autopay_oneoff_after_days integer;
