-- 056_credit_student_attribution.sql
--
-- Schools account by STUDENT record. Credits gain an optional
-- student_id so a credit can be attributed to a specific child
-- (invoices already had student_id + responsible_parent_id from
-- migrations 018/045 — this round exposes them in the UI).

BEGIN;

ALTER TABLE family_credits
  ADD COLUMN IF NOT EXISTS student_id uuid REFERENCES students(id) ON DELETE SET NULL;

COMMENT ON COLUMN family_credits.student_id IS
  'Optional student attribution. NULL = family-level credit. Apply-to-invoice prefers credits whose student matches the invoice''s student.';

COMMIT;
