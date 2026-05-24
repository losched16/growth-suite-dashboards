-- Migration support for schools that had pre-existing GHL forms before
-- the portal-forms engine existed. Two additions:
--
--   1) portal_form_definitions.legacy_completion_field_key
--      A GHL custom-field key (on the parent's contact) that, if non-empty,
--      means "this family already completed this form via the legacy GHL
--      form." The renderer reads this to show a "Complete via legacy form"
--      lock state with an "Update my answers" button.
--
--   2) portal_migration_flags
--      Per-family review items raised by the legacy importer. Examples:
--        - emergency_contacts_per_student_review
--        - possible_student_data_collision
--        - missing_submission_for_student
--        - student_attribution_unknown
--      Parents see banners/badges; school sees a filter in the inbox.

ALTER TABLE portal_form_definitions
  ADD COLUMN IF NOT EXISTS legacy_completion_field_key text;

-- New flags table
CREATE TABLE IF NOT EXISTS portal_migration_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  student_id uuid REFERENCES students(id) ON DELETE CASCADE,
  form_definition_id uuid REFERENCES portal_form_definitions(id) ON DELETE CASCADE,

  flag_kind text NOT NULL,
  flag_message text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,

  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','dismissed','resolved')),
  resolved_at timestamptz,
  resolved_by_parent_id uuid REFERENCES parents(id) ON DELETE SET NULL,
  resolution_note text,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_portal_migration_flags_family
  ON portal_migration_flags (school_id, family_id, status);
CREATE INDEX IF NOT EXISTS idx_portal_migration_flags_form
  ON portal_migration_flags (school_id, form_definition_id, status);

-- Allow legacy submissions to be inserted with a status of 'legacy_imported'
-- so they show up in history but are visually distinguished from native ones.
ALTER TABLE portal_form_submissions
  DROP CONSTRAINT IF EXISTS portal_form_submissions_status_check;
ALTER TABLE portal_form_submissions
  ADD CONSTRAINT portal_form_submissions_status_check
  CHECK (status IN ('draft','submitted','pending_payment','paid','voided','legacy_imported'));

-- Track that a submission came from the importer (vs. native portal flow)
ALTER TABLE portal_form_submissions
  ADD COLUMN IF NOT EXISTS legacy_source text;  -- e.g. 'wooster_csv_v1' or NULL for native
