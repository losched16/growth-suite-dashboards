-- 041_form_test_nullable_family.sql
--
-- Test submissions (is_test=true, from staff preview) have no real
-- family or parent attached. Relax the NOT NULL constraints on
-- family_id + parent_id and re-enforce both-or-neither via a CHECK:
-- real submissions must still have both; tests can have neither.

ALTER TABLE portal_form_submissions
  ALTER COLUMN family_id DROP NOT NULL;
ALTER TABLE portal_form_submissions
  ALTER COLUMN parent_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'portal_form_submissions_real_has_family_parent'
  ) THEN
    ALTER TABLE portal_form_submissions
      ADD CONSTRAINT portal_form_submissions_real_has_family_parent
      CHECK (is_test = true OR (family_id IS NOT NULL AND parent_id IS NOT NULL));
  END IF;
END$$;
