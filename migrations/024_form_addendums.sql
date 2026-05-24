-- Form addendums — partial updates to a previously submitted form.
--
-- Use case: parent submitted the Emergency Medical form in August.
-- In December the child gets a new prescription. Rather than re-doing
-- the entire 30-question form, the parent picks just the "current
-- medications" field, signs, and submits. The school still sees the
-- original submission AND the addendum on top.
--
-- Data model:
--   - An addendum is just another row in portal_form_submissions
--   - is_addendum = true
--   - parent_submission_id points back at the original
--   - addendum_fields[] lists the field keys that were updated
--   - responses jsonb contains only those keys (no need to redact —
--     the operator merges by walking the chain, latest value wins)
--
-- Operator's "current effective" state: latest non-null value per key
-- across (original, addendum1, addendum2, …).

ALTER TABLE portal_form_submissions
  ADD COLUMN IF NOT EXISTS is_addendum boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS parent_submission_id uuid
    REFERENCES portal_form_submissions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS addendum_fields text[] NULL;

CREATE INDEX IF NOT EXISTS idx_portal_form_subs_parent_submission
  ON portal_form_submissions (parent_submission_id)
  WHERE parent_submission_id IS NOT NULL;

-- Per-form opt-in. Forms with sensitive data that changes often
-- (emergency medical, financial) should set this true; one-time forms
-- (waivers, attestations) typically don't need it.
ALTER TABLE portal_form_definitions
  ADD COLUMN IF NOT EXISTS allow_addendum boolean NOT NULL DEFAULT false;

-- Convenience: turn on addendum support for the form types where it's
-- most useful. The actual list of slugs varies per school; here we
-- match common ones across all schools. Operators can flip the flag
-- per definition via SQL or the admin UI later.
UPDATE portal_form_definitions
   SET allow_addendum = true
 WHERE LOWER(slug) IN (
   'emergency-medical', 'emergency-and-medical', 'emergency-card',
   'medical-emergency', 'health-emergency',
   'financial-aid', 'financial-aid-application',
   'authorized-pickup', 'pickup-authorization'
 );

COMMENT ON COLUMN portal_form_submissions.is_addendum IS
  'TRUE when this row is a partial update to a previously submitted form. parent_submission_id points back at the original.';
COMMENT ON COLUMN portal_form_submissions.addendum_fields IS
  'Field keys that this addendum updates. The responses jsonb only contains values for these keys.';
COMMENT ON COLUMN portal_form_definitions.allow_addendum IS
  'When TRUE, parents can submit a partial update (addendum) against an existing submission instead of re-doing the whole form.';
