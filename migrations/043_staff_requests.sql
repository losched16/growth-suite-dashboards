-- 043_staff_requests.sql
--
-- Extends portal_form_definitions + portal_form_submissions to support
-- STAFF-submitted requests (Labor Request, Incident/Accident Report,
-- In-house Supplies). These don't have a family/parent attached — the
-- submitter is a teacher, identified by their school-session email.
--
-- Admin (Lexi) routes them through a status lifecycle and optionally
-- assigns a scheduled date. The teacher sees that update in their
-- "My Requests" view but can't edit it.
--
-- Changes:
--   1. portal_form_definitions.audience text — 'parents' (default,
--      existing behavior) or 'staff' (this new flow). Lets us filter
--      the parent-portal form picker out of staff-only forms.
--   2. portal_form_submissions:
--      - submitter_email text     — populated for staff submissions
--      - assigned_to_email text   — who's handling it (defaults to
--        notify_emails[0] when set; admin can reassign)
--      - scheduled_date date      — for labor requests etc.
--      - admin_notes text         — Lexi's internal notes
--      - acknowledged_at timestamp
--      - scheduled_at timestamp
--      - completed_at timestamp
--      - resolved_status text     — 'pending' | 'acknowledged' |
--        'scheduled' | 'completed' | 'rejected'
--        (kept separate from the existing `status` column which is
--        about parent-form submission lifecycle, not admin workflow)
--   3. CHECK constraint update: a row is valid when is_test=true OR
--      submitter_email IS NOT NULL (staff) OR family+parent set (parent).

-- ── portal_form_definitions: audience ───────────────────────────────
ALTER TABLE portal_form_definitions
  ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'parents'
    CHECK (audience IN ('parents', 'staff'));

COMMENT ON COLUMN portal_form_definitions.audience IS
  'parents = shows in the parent-portal form picker; staff = shows in the staff/teacher classroom hub submit list, routed to admin via notify_emails for workflow handling.';

-- ── portal_form_submissions: staff workflow columns ─────────────────
ALTER TABLE portal_form_submissions
  ADD COLUMN IF NOT EXISTS submitter_email text;

ALTER TABLE portal_form_submissions
  ADD COLUMN IF NOT EXISTS assigned_to_email text;

ALTER TABLE portal_form_submissions
  ADD COLUMN IF NOT EXISTS scheduled_date date;

ALTER TABLE portal_form_submissions
  ADD COLUMN IF NOT EXISTS admin_notes text;

ALTER TABLE portal_form_submissions
  ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz;

ALTER TABLE portal_form_submissions
  ADD COLUMN IF NOT EXISTS scheduled_at timestamptz;

ALTER TABLE portal_form_submissions
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

ALTER TABLE portal_form_submissions
  ADD COLUMN IF NOT EXISTS resolved_status text NOT NULL DEFAULT 'pending'
    CHECK (resolved_status IN ('pending', 'acknowledged', 'scheduled', 'completed', 'rejected'));

CREATE INDEX IF NOT EXISTS idx_portal_form_submissions_staff_queue
  ON portal_form_submissions (school_id, resolved_status, submitted_at DESC)
  WHERE submitter_email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_portal_form_submissions_submitter
  ON portal_form_submissions (school_id, submitter_email, submitted_at DESC)
  WHERE submitter_email IS NOT NULL;

-- ── Relax the family/parent NOT NULL for staff submissions ──────────
-- Migration 041 added a CHECK requiring family+parent OR is_test=true.
-- Staff submissions are a third valid case — relax to allow.
ALTER TABLE portal_form_submissions
  DROP CONSTRAINT IF EXISTS portal_form_submissions_real_has_family_parent;

ALTER TABLE portal_form_submissions
  ADD CONSTRAINT portal_form_submissions_real_has_family_parent
  CHECK (
    is_test = true
    OR submitter_email IS NOT NULL
    OR (family_id IS NOT NULL AND parent_id IS NOT NULL)
  );
