-- 055_credits_and_late_fees.sql
--
-- Two CFO-critical gaps:
--
-- 1. FAMILY CREDITS — a real credit ledger. The CFO issues a credit to
--    a family (refund-in-kind, goodwill, overpayment, withdrawal
--    proration); it sits on the family's account and gets applied to
--    invoices (negative line item) until exhausted. Full audit trail
--    via credit_applications.
--
-- 2. LATE FEE AUTOMATION — school_payment_config.late_fee_amount_cents
--    existed but nothing applied it. invoices.late_fee_applied_at lets
--    the daily cron apply the fee exactly once per overdue invoice.

BEGIN;

CREATE TABLE IF NOT EXISTS family_credits (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  family_id        uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  amount_cents     integer NOT NULL CHECK (amount_cents > 0),
  remaining_cents  integer NOT NULL,
  reason           text,
  created_by_email text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (remaining_cents >= 0 AND remaining_cents <= amount_cents)
);
CREATE INDEX IF NOT EXISTS family_credits_family_idx ON family_credits (school_id, family_id) WHERE remaining_cents > 0;

CREATE TABLE IF NOT EXISTS credit_applications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_id     uuid NOT NULL REFERENCES family_credits(id) ON DELETE CASCADE,
  invoice_id    uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount_cents  integer NOT NULL CHECK (amount_cents > 0),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS credit_applications_invoice_idx ON credit_applications (invoice_id);

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS late_fee_applied_at timestamptz;

COMMENT ON TABLE family_credits IS 'Account credits a school issues to a family; applied to invoices as negative line items until exhausted.';
COMMENT ON COLUMN invoices.late_fee_applied_at IS 'Set when the daily cron applies the school''s configured late fee to this overdue invoice. NULL = not (yet) applied. One application max.';

COMMIT;
