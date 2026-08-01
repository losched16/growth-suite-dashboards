-- 089: raise the student-document size cap from 10MB to 50MB.
--
-- Scanned student records / cumulative files routinely exceed 10MB.
-- Uploads already arrive in ~3MB slices (Vercel gateway cap), so the
-- only real limits were this CHECK and the matching route constants.

ALTER TABLE student_documents
  DROP CONSTRAINT IF EXISTS student_documents_size_bytes_check;
ALTER TABLE student_documents
  ADD CONSTRAINT student_documents_size_bytes_check
  CHECK (size_bytes > 0 AND size_bytes <= 52428800);
