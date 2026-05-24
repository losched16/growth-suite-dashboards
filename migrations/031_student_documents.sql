-- Per-student document attachments. Files are stored as bytea inside
-- this table — matches the portal_form_submission_files / parent_uploads
-- pattern. 10MB cap enforced both in the upload route and via the size
-- check below.
--
-- The DB is the source of truth. If we ever migrate to Supabase
-- Storage / S3, we'd:
--   1. Walk this table, push each file_bytes blob to the storage
--      bucket at the new storage_path
--   2. NULL out file_bytes
--   3. Update read paths to prefer storage_path > file_bytes
-- The storage_path column is already here for that future swap.

CREATE TABLE IF NOT EXISTS student_documents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id          uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id         uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,

  -- Display
  title              text NOT NULL,           -- e.g. "Birth certificate"
  category           text,                    -- 'health' / 'enrollment' / 'iep' / 'transcript' / 'other'
  description        text,                    -- optional context

  -- File storage. file_bytes is the bytea blob for v1; storage_path is
  -- reserved for a future swap to Supabase Storage / S3.
  file_name          text NOT NULL,           -- original filename
  mime_type          text NOT NULL,
  size_bytes         int NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),  -- 10MB cap
  file_bytes         bytea,                   -- the file contents (v1)
  storage_path       text,                    -- reserved for future migration

  -- Audit
  uploaded_by        text,                    -- operator email
  uploaded_at        timestamptz NOT NULL DEFAULT now(),

  -- Visibility flags (consumed by the dashboard's per-role filters)
  visible_to_teacher boolean NOT NULL DEFAULT true,
  visible_to_parent  boolean NOT NULL DEFAULT false,

  -- Optional expiration (e.g. immunization records)
  expires_at         date,

  CHECK (file_bytes IS NOT NULL OR storage_path IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_student_docs_school
  ON student_documents (school_id, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_student_docs_student
  ON student_documents (student_id, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_student_docs_category
  ON student_documents (school_id, category) WHERE category IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_student_docs_expiring
  ON student_documents (school_id, expires_at) WHERE expires_at IS NOT NULL;

COMMENT ON TABLE  student_documents IS
  'Per-student document attachments. v1 uses bytea storage; storage_path is reserved for a future migration to object storage.';
COMMENT ON COLUMN student_documents.visible_to_teacher IS
  'True = visible on the Student Roster row in the teacher-scoped dashboard. False = admin-only.';
COMMENT ON COLUMN student_documents.visible_to_parent IS
  'True = visible to this student''s family in the parent portal.';
