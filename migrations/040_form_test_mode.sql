-- 040_form_test_mode.sql
--
-- Supports "Test mode" in the form preview:
--
-- 1. portal_form_submissions.is_test — staff-initiated submissions get
--    this flag set so the regular inbox can filter them out and real
--    workflows (notifications, GHL writebacks, Stripe charges) can
--    suppress side effects.
--
-- 2. portal_form_definitions.confirmation_message — optional rich-text
--    thank-you message rendered to the parent after a successful
--    submission. Staff can configure this per form and verify it via
--    test-mode preview.
--
-- 3. portal_form_definitions.confirmation_redirect_url — optional
--    URL to redirect the parent to after submission instead of (or in
--    addition to) showing the in-app thank-you. Common use case:
--    pointing back at the school's website with a "thanks for
--    enrolling" landing page they control.
--
-- 4. portal_form_definitions.notify_emails — array of office email
--    addresses that should receive a notification when a real
--    submission comes in. Surfaced in the dry-run report so staff can
--    verify who'll be looped in.

ALTER TABLE portal_form_submissions
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_portal_form_submissions_is_test
  ON portal_form_submissions (form_definition_id, is_test);

ALTER TABLE portal_form_definitions
  ADD COLUMN IF NOT EXISTS confirmation_message text;

ALTER TABLE portal_form_definitions
  ADD COLUMN IF NOT EXISTS confirmation_redirect_url text;

ALTER TABLE portal_form_definitions
  ADD COLUMN IF NOT EXISTS notify_emails text[] NOT NULL DEFAULT '{}'::text[];

COMMENT ON COLUMN portal_form_submissions.is_test IS
  'TRUE when this submission was created by staff via preview test mode. Excluded from the normal inbox; downstream workflows (notifications, GHL writebacks, Stripe charges) are suppressed.';

COMMENT ON COLUMN portal_form_definitions.confirmation_message IS
  'Optional thank-you message shown to the parent after a successful submission. Plain text with line breaks preserved.';

COMMENT ON COLUMN portal_form_definitions.confirmation_redirect_url IS
  'Optional URL to redirect the parent to after submission. If both confirmation_message and this are set, the message shows briefly then auto-redirects.';

COMMENT ON COLUMN portal_form_definitions.notify_emails IS
  'Office emails to notify when a real (non-test) submission arrives.';
