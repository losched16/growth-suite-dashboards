-- Applicant portal invites.
--
-- Admissions schools onboard APPLICANTS into the parent portal before they are
-- ever students: when a contact reaches the school's "ready to apply" stage, a
-- GHL workflow calls /api/webhooks/ghl/applicant-invite, which creates a
-- parent-only family and emails the invite. That invitation is itself the
-- authorization to create a portal login, so the invited parents are stamped
-- here and the portal's provisioning gate (lib/auth/portal-provisioning.ts)
-- lets a stamped family through — no pipeline-stage list to keep in sync.
--
-- Nullable and additive: every existing parent keeps NULL and behaves exactly
-- as before.

ALTER TABLE parents ADD COLUMN IF NOT EXISTS portal_invited_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_parents_portal_invited
  ON parents (family_id) WHERE portal_invited_at IS NOT NULL;
