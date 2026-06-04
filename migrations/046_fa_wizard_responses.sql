-- 046_fa_wizard_responses.sql
--
-- Add structured `responses` JSONB to fa_applications so the new
-- 7-step wizard can persist rich answers without ballooning the
-- column count. Keeps the existing flat numeric columns for the
-- admin queue's "filter by income range" style queries — those
-- get populated from responses on submit.
--
-- Also adds:
--   wizard_step  — last step the parent saved (1..7). Lets us
--                  resume where they left off when they come back.
--   last_saved_at — separate from updated_at because we update
--                  rows for award changes too; this column tells
--                  the parent "saved 3 minutes ago".

BEGIN;

ALTER TABLE fa_applications
  ADD COLUMN IF NOT EXISTS responses    jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS wizard_step  integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_saved_at timestamptz;

CREATE INDEX IF NOT EXISTS fa_applications_responses_gin
  ON fa_applications USING GIN (responses);

COMMENT ON COLUMN fa_applications.responses IS
  'Structured wizard answers. Top-level keys mirror wizard sections: household, income, real_estate, vehicles, assets, expenses, other.';
COMMENT ON COLUMN fa_applications.wizard_step IS
  'Last step (1..7) the parent saved progress on. Used to resume the wizard.';

COMMIT;
