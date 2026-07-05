-- Adds reminder bookkeeping to school_onboarding so the nightly reminder cron
-- can nudge stalled schools without spamming them. last_reminded_at gates the
-- cadence; last_status_at records when we last recomputed + persisted progress.

ALTER TABLE school_onboarding
  ADD COLUMN IF NOT EXISTS last_reminded_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS last_status_at   timestamptz NULL;
