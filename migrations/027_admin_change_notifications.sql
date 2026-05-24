-- Admin-side change notifications.
--
-- DGM use case: when a parent submits an enrollment with updated
-- parent/guardian information (name, address, phone, email, employer),
-- the system emails Leslie so she can mirror the change into
-- Transparent Classroom (TC), the school's external SIS.
--
-- Per-school destination address lives here. Fallbacks (in order):
--   1. school_branding.admin_change_notification_email
--   2. school_branding.support_email
--   3. RESEND_REPLY_TO env var
--   4. (no-op — log a warning and skip)

ALTER TABLE school_branding
  ADD COLUMN IF NOT EXISTS admin_change_notification_email text;

-- Placeholder for DGM. Operator should update with Leslie's real address
-- via the admin branding UI (or SQL) once we have it.
UPDATE school_branding
   SET admin_change_notification_email = COALESCE(
     admin_change_notification_email,
     'admissions@desertgardenmontessori.org'
   )
 WHERE school_id = 'cfa9030d-c8fe-49ae-a9e7-f1003844ec07';

COMMENT ON COLUMN school_branding.admin_change_notification_email IS
  'Inbox that receives operator-side alerts when parents change information that needs to be mirrored into an external SIS (e.g. Transparent Classroom).';
