-- Payments Phase 2 — autopay + saved payment-method support.
--
-- Adds the columns needed to:
--   1. Enable autopay on an individual invoice (with which saved
--      payment method to charge)
--   2. Track failed off-session charge attempts + retry schedule
--   3. Mark a saved payment method as the family's "default for autopay"
--      (already in payment_methods.is_default — no schema change there)

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS autopay_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS autopay_payment_method_id uuid REFERENCES payment_methods(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS autopay_charge_on date,             -- if NULL, charge on due_at::date
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz,
  ADD COLUMN IF NOT EXISTS retry_attempt_count int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_autopay_attempted_at timestamptz;

-- Quick lookup: which invoices are due for autopay processing today?
CREATE INDEX IF NOT EXISTS idx_invoices_autopay_due
  ON invoices (school_id, autopay_enabled, autopay_charge_on)
  WHERE autopay_enabled = true AND status IN ('open', 'partially_paid');

CREATE INDEX IF NOT EXISTS idx_invoices_autopay_retry
  ON invoices (next_retry_at)
  WHERE next_retry_at IS NOT NULL AND status IN ('open', 'partially_paid');

-- Cron run audit log so operators can see what happened on any given day.
CREATE TABLE IF NOT EXISTS autopay_run_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at timestamptz NOT NULL DEFAULT now(),
  invoices_attempted int NOT NULL DEFAULT 0,
  invoices_succeeded int NOT NULL DEFAULT 0,
  invoices_failed int NOT NULL DEFAULT 0,
  invoices_skipped int NOT NULL DEFAULT 0,
  duration_ms int,
  details jsonb
);
