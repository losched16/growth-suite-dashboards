-- 042_form_webhooks.sql
--
-- Adds webhook fan-out support to portal_form_definitions.
--
-- webhook_urls: optional list of HTTPS URLs. On each REAL submission
-- (is_test=false) the parent-portal submit handler POSTs a JSON
-- payload to every URL in this list (fire-and-forget with a short
-- timeout — failures don't block the submission). Test submissions
-- never fire webhooks; the dry-run report shows what payload would
-- have been sent.
--
-- This is the "automation trigger" surface — schools can wire form
-- submissions into Zapier, n8n, make.com, GHL inbound webhooks,
-- their own backend, etc.

ALTER TABLE portal_form_definitions
  ADD COLUMN IF NOT EXISTS webhook_urls text[] NOT NULL DEFAULT '{}'::text[];

COMMENT ON COLUMN portal_form_definitions.webhook_urls IS
  'HTTPS URLs that receive a JSON POST on every real submission. Test submissions are suppressed; the dry-run report shows the would-be payload.';
