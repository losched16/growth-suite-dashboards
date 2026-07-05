-- Soft-archive for onboardings (dead leads / finished). Archived rows drop off
-- the active board and are skipped by the reminder cron, but are preserved.

ALTER TABLE school_onboarding
  ADD COLUMN IF NOT EXISTS archived_at timestamptz NULL;
