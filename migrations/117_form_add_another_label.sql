-- What each entry is called on a form that accepts several entries
-- (allow_multiple_submissions): "medication", "document", ... It words the
-- "Submit & add another <label>" and "Add another <label>" buttons in the portal.
-- NULL = generic "Add another". Idempotent.
ALTER TABLE portal_form_definitions
  ADD COLUMN IF NOT EXISTS add_another_label text;
