-- 060_form_notifications_toggle.sql
--
-- Per-form on/off switch for submission notification emails.
--
-- Today, a form sends notification emails to every address in its
-- `notify_emails` array on every submission. Schools want to be able
-- to mute notifications for a given form WITHOUT deleting the email
-- list (so they can re-enable later without re-typing addresses).
--
-- New `notifications_enabled` boolean. Defaults TRUE so existing forms
-- keep behavior; admin flips OFF to mute. Submit handler reads this
-- before fanning out emails.

BEGIN;

ALTER TABLE portal_form_definitions
  ADD COLUMN IF NOT EXISTS notifications_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN portal_form_definitions.notifications_enabled IS
  'Master switch for the per-form submission-notification fan-out. When false, NO emails go to notify_emails on submission. Set via the Forms tab toggle.';

COMMIT;
