-- 062: split "credits applied" out of payments on the FACTS ledger.
--
-- The school's own reconciliation separates a tuition reduction into cash
-- PAYMENTS vs CREDITS APPLIED (e.g. an account credit / overpayment moved
-- onto tuition). Both reduce the balance, but the CFO tracks them in
-- separate columns. We were storing the combined figure in payments_cents;
-- this adds credits_applied_cents so the statement can show her exact
-- breakout (Charges · Credits · Payments · Credits applied · Balance).

ALTER TABLE facts_account_ledger
  ADD COLUMN IF NOT EXISTS credits_applied_cents integer NOT NULL DEFAULT 0;
