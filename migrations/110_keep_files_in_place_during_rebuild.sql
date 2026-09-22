-- student_documents and parent_uploads stay in place during the sync rebuild.
--
-- The snapshot rebuild deletes and re-creates a school's students, parents
-- and families (same ids) inside one transaction. Until now these two
-- tables — whose rows carry the uploaded FILE BYTES — were copied out to a
-- temp table, cascade-deleted with the students, and re-inserted from the
-- copy: for DGM that is ~140 MB written three times every 5 minutes
-- (profiled 2026-09-22: 87 of the rebuild's 141 seconds), and it is what
-- kept the database's disk throttled after the attendance-signature fix.
--
-- With these constraints the rows simply stay put: the referential check
-- is deferred to COMMIT, by which time every surviving student/parent/
-- family has been re-inserted under its original id. Rows whose anchor
-- genuinely left the CRM are handled by the sync before COMMIT exactly as
-- the old restore did (student_documents: row dropped; parent_uploads:
-- parent_id/student_id nulled, row dropped only if its family is gone).
--
-- The sync detects these definitions at runtime and only skips the
-- round-trip once they are in place, so deploy order cannot lose data.
-- Outside the sync nothing deletes students/parents/families except one-off
-- import scripts, where a deferred NO ACTION failure is the safe outcome.
ALTER TABLE student_documents
  DROP CONSTRAINT student_documents_student_id_fkey,
  ADD CONSTRAINT student_documents_student_id_fkey
    FOREIGN KEY (student_id) REFERENCES students(id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE parent_uploads
  DROP CONSTRAINT parent_uploads_family_id_fkey,
  ADD CONSTRAINT parent_uploads_family_id_fkey
    FOREIGN KEY (family_id) REFERENCES families(id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  DROP CONSTRAINT parent_uploads_parent_id_fkey,
  ADD CONSTRAINT parent_uploads_parent_id_fkey
    FOREIGN KEY (parent_id) REFERENCES parents(id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  DROP CONSTRAINT parent_uploads_student_id_fkey,
  ADD CONSTRAINT parent_uploads_student_id_fkey
    FOREIGN KEY (student_id) REFERENCES students(id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
