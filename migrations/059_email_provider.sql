-- Per-school email provider selection.
--
-- 'resend' (default) — transactional email sends via Resend, the
--   historical path. DGM / Wooster / NLMA and any school whose GHL
--   location does NOT have a verified email-sending domain stay here.
--
-- 'ghl' — transactional email sends through the school's GHL location
--   via the Conversations API (type=Email), so every message threads
--   into the contact's GHL conversation history and uses the school's
--   own GHL sending domain/reputation. On ANY GHL send error (no PIT,
--   no resolvable contact, API failure) the sender falls back to Resend
--   so email never silently stops going out.
--
-- Set per school once their GHL location has email sending configured.

ALTER TABLE school_branding
  ADD COLUMN IF NOT EXISTS email_provider text NOT NULL DEFAULT 'resend';

-- Guard against typos — only the two known values are valid.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'school_branding_email_provider_chk'
  ) THEN
    ALTER TABLE school_branding
      ADD CONSTRAINT school_branding_email_provider_chk
      CHECK (email_provider IN ('resend', 'ghl'));
  END IF;
END $$;

COMMENT ON COLUMN school_branding.email_provider IS
  'Which provider transactional email uses for this school. resend (default) or ghl. ghl routes via the Conversations API with automatic Resend fallback on error.';
