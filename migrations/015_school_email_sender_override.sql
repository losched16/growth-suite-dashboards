-- Per-school email sender overrides.
--
-- Adds two optional columns to school_branding so each school can have
-- emails go out from their own domain instead of the Growth Suite
-- default (family@mygrowthsuite.com).
--
-- When sending, lib/email.ts looks up these values and falls back to
-- the RESEND_FROM_ADDRESS / RESEND_REPLY_TO env vars when null.
--
-- Note: the From address must be on a domain that's verified in
-- Resend. Otherwise the send fails / lands in spam.

ALTER TABLE school_branding
  ADD COLUMN IF NOT EXISTS email_from_address text,
  ADD COLUMN IF NOT EXISTS email_from_name text,
  ADD COLUMN IF NOT EXISTS email_reply_to_address text;
