-- 067_submission_fks_deferrable.sql
-- The snapshot sync rebuilds a school by DELETE-all + reinsert-with-same-ids
-- inside ONE transaction. portal_form_submissions points at families/parents/
-- students; with ON DELETE CASCADE (family) / SET NULL (parent, student) those
-- references got destroyed or nulled mid-rebuild — and a real submission with
-- a nulled parent_id violates the real_has_family_parent CHECK, aborting the
-- whole sync. (This is exactly what broke DGM 2.0 once a co-sign submission
-- existed.)
--
-- Fix: make these three FKs DEFERRABLE INITIALLY DEFERRED with NO ACTION (no
-- cascade / no set-null). The transient delete-before-reinsert is tolerated
-- until COMMIT, by which point the rows are back with their original ids, so
-- the submission keeps its links intact. (Hard-deleting a referenced row
-- without reinserting it will now fail at commit — which is correct: don't
-- silently destroy a signed submission's links.)

ALTER TABLE portal_form_submissions DROP CONSTRAINT IF EXISTS portal_form_submissions_family_id_fkey;
ALTER TABLE portal_form_submissions
  ADD CONSTRAINT portal_form_submissions_family_id_fkey
  FOREIGN KEY (family_id) REFERENCES families(id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE portal_form_submissions DROP CONSTRAINT IF EXISTS portal_form_submissions_parent_id_fkey;
ALTER TABLE portal_form_submissions
  ADD CONSTRAINT portal_form_submissions_parent_id_fkey
  FOREIGN KEY (parent_id) REFERENCES parents(id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE portal_form_submissions DROP CONSTRAINT IF EXISTS portal_form_submissions_student_id_fkey;
ALTER TABLE portal_form_submissions
  ADD CONSTRAINT portal_form_submissions_student_id_fkey
  FOREIGN KEY (student_id) REFERENCES students(id)
  DEFERRABLE INITIALLY DEFERRED;
