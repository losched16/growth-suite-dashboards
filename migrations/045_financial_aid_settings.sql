-- 045_financial_aid_settings.sql
--
-- Multi-tenant financial aid platform configuration.
--
-- Before this migration: every school used hardcoded defaults
-- ('2025-26', no deadline, no required docs, etc.). Parent-portal
-- showed "Apply for Financial Aid" even for schools that don't offer
-- it.
--
-- After: each school has one row in school_financial_aid_settings
-- that drives:
--   - whether the parent portal surfaces FA at all (is_enabled)
--   - the active academic year (defaults the application + queue)
--   - whether new applications can be submitted (application_open)
--   - the deadline shown to parents
--   - markdown intro copy parents see on the FA landing
--   - which document types parents must upload (e.g. tax_return, w2)
--   - admins to email on new submissions
--   - max per-student award ceiling (sanity check in queue widget)
--   - decision-letter template (variables filled in at PDF time)
--
-- Default: OFF. New schools opt in via the admin UI or by passing
-- --enable-fa to the provisioner. Existing schools keep working
-- because the parent portal falls back to legacy defaults when no
-- row exists yet (transition-friendly).

BEGIN;

CREATE TABLE IF NOT EXISTS school_financial_aid_settings (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id                 uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,

  -- Master switch. When false, the parent portal hides FA and the
  -- admin queue widget shows a "FA disabled" state.
  is_enabled                boolean NOT NULL DEFAULT false,

  -- Current/active year — used as the default in both the apply form
  -- and the admin queue filter. Format 'YYYY-YY'.
  active_academic_year      text NOT NULL DEFAULT '2026-27',

  -- When false, parents can VIEW past applications but cannot submit
  -- new ones (e.g. deadline passed). is_enabled=false trumps this.
  application_open          boolean NOT NULL DEFAULT true,

  -- Deadline shown to parents on the FA landing. Soft — server still
  -- accepts submissions until application_open is flipped to false.
  application_deadline      date,

  -- Markdown copy shown on the parent portal FA landing. Should
  -- explain the school's FA philosophy, what's required, expected
  -- decision timeline, etc.
  intro_copy_markdown       text,

  -- text[] of document keys parents must upload. Examples:
  --   tax_return       — last year's 1040
  --   w2               — W-2 forms
  --   pay_stubs        — recent pay stubs
  --   ssa_statement    — Social Security benefits letter
  --   custody_order    — custody/divorce decree
  --   other            — free-text other docs
  -- Empty array = no required docs (parents can still upload anything
  -- they want as supporting).
  required_document_types   text[] NOT NULL DEFAULT ARRAY[]::text[],

  -- Per-student sanity ceiling shown in the admin queue ("$NK ceiling")
  -- and used to flag obvious typos when an admin enters an award.
  max_award_per_student_cents integer NOT NULL DEFAULT 5000000,  -- $50,000

  -- Comma-separated emails to notify when a new application is
  -- submitted. The admin queue is the source of truth for review,
  -- but these emails give the office a heads-up.
  admin_notify_emails       text[] NOT NULL DEFAULT ARRAY[]::text[],

  -- Decision letter template — markdown with {{variable}} placeholders.
  -- Variables we substitute when generating the PDF:
  --   {{family_name}}, {{academic_year}}, {{student_list}},
  --   {{total_award}}, {{decision_note}}, {{school_name}},
  --   {{signature_name}}
  -- Blank → fall back to a generic template baked into the renderer.
  decision_letter_template  text,

  -- Auto-fill on decision letters
  signature_name            text,
  signature_title           text,

  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT school_financial_aid_settings_school UNIQUE (school_id)
);

CREATE INDEX IF NOT EXISTS school_financial_aid_settings_enabled_idx
  ON school_financial_aid_settings(is_enabled) WHERE is_enabled = true;

COMMENT ON TABLE school_financial_aid_settings IS
  'Per-school FA configuration. Drives parent-portal visibility, active year, deadline, required docs, and the admin queue defaults. Missing row = FA disabled (legacy default).';

-- Add 'under_review' to the fa_applications.status workflow. Existing
-- rows keep their current status; new state is opt-in.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fa_applications_status_check_v2'
  ) THEN
    -- Drop any old CHECK constraint on status (we don't know its name
    -- pre-migration so do this defensively).
    ALTER TABLE fa_applications
      DROP CONSTRAINT IF EXISTS fa_applications_status_check;
    -- New constraint allows the full state machine.
    ALTER TABLE fa_applications
      ADD CONSTRAINT fa_applications_status_check_v2
      CHECK (status IN ('draft','submitted','under_review','decided','withdrawn','declined'));
  END IF;
END$$;

-- Convenience: track who put the app into review and when.
ALTER TABLE fa_applications
  ADD COLUMN IF NOT EXISTS review_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_started_by text;

COMMIT;
