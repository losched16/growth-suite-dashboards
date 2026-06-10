-- 052_invoice_any_recipient.sql
--
-- Let a school invoice ANY recipient — a GHL contact or a raw email —
-- not just families that exist in our local DB.
--
-- Before: invoices.family_id was NOT NULL and the recipient/email were
-- derived family → parents. Now family_id is optional; when an invoice
-- targets a non-family recipient we store the recipient details inline.
--
-- Because non-family recipients have no parent-portal login, every
-- invoice also gets a random public_pay_token. The recipient pays via
-- a tokenized public link (/pay/<id>?t=<token>) — no login required.
-- Family invoices keep working through the existing logged-in pay page;
-- the token is just an additional access path.

BEGIN;

ALTER TABLE invoices
  ALTER COLUMN family_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS recipient_name text,
  ADD COLUMN IF NOT EXISTS recipient_email text,
  ADD COLUMN IF NOT EXISTS recipient_ghl_contact_id text,
  ADD COLUMN IF NOT EXISTS public_pay_token text;

-- Payments for a non-family invoice have no family / paying parent.
ALTER TABLE payments
  ALTER COLUMN family_id DROP NOT NULL;

DO $$ BEGIN
  -- paid_by_parent_id may already be nullable; guard the ALTER.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'payments' AND column_name = 'paid_by_parent_id'
       AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE payments ALTER COLUMN paid_by_parent_id DROP NOT NULL;
  END IF;
END $$;

-- Backfill a token for existing invoices so the public link works for
-- them too (e.g. resending an old invoice to a non-portal payer).
UPDATE invoices
   SET public_pay_token = encode(gen_random_bytes(18), 'hex')
 WHERE public_pay_token IS NULL;

-- Either a family OR an inline recipient email must be present.
ALTER TABLE invoices
  ADD CONSTRAINT invoices_has_recipient
  CHECK (family_id IS NOT NULL OR recipient_email IS NOT NULL)
  NOT VALID;   -- NOT VALID: don't retro-check old rows (all have family_id)

COMMENT ON COLUMN invoices.recipient_email IS
  'For non-family invoices: the email the invoice is sent to. NULL when family_id is set (derived from parents).';
COMMENT ON COLUMN invoices.public_pay_token IS
  'Random token for the public pay link /pay/<id>?t=<token>. Lets a non-family recipient pay without a portal login.';

COMMIT;
