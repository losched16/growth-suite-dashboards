-- Staff directory moves from code (DGM_STAFF_DIRECTORY in
-- lib/auth/teacher-identity.ts) to data, so the office can add/remove
-- staff without a deploy. Feeds the "Pick your name" identity picker
-- on Staff Forms / My Submissions / menu editor.
--
-- No FK to schools: consistent with the other config tables; school
-- rows are never deleted in practice and a dangling row is harmless.

CREATE TABLE IF NOT EXISTS school_staff_directory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL,
  email text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS school_staff_directory_school_email
  ON school_staff_directory (school_id, lower(email));
