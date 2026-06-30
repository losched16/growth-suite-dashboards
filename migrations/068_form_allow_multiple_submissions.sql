-- Allow a form to accept multiple INDEPENDENT submissions per student.
-- When true, the parent portal never "locks" the form after a submission —
-- each submit is a new, separate record (prior ones are kept, not
-- overwritten). Use for forms like the Medication Authorization, where a
-- student on multiple medications needs one signed slip per medication.
-- Default false preserves the existing submit-once / update behavior.

ALTER TABLE portal_form_definitions
  ADD COLUMN IF NOT EXISTS allow_multiple_submissions boolean NOT NULL DEFAULT false;

-- Media Children's House Medication Authorization: one form per medication.
UPDATE portal_form_definitions
   SET allow_multiple_submissions = true, updated_at = now()
 WHERE slug = 'mch-medication-log';
