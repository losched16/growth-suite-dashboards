-- Switch FA applications from per-student to per-household. Schools do
-- one application per family per year (covering whatever kids attend
-- the school), not one app per kid. Per-student detail (tuition,
-- requested aid, awarded amount) moves to a child table so the form
-- can capture each student's situation without splitting into multiple
-- applications.
--
-- Migration plan:
--   1. fa_application_students child table (per-student rows under one app)
--   2. Copy existing per-student data into the child table
--   3. Drop the per-student unique constraint on fa_applications
--   4. Add per-household unique index
--   5. Make student_id nullable + plan to drop in a later migration
--      (kept for now so we don't break in-flight queries)
--
-- Semantic change on fa_applications:
--   - requested_aid          → now the FAMILY TOTAL (sum across students)
--   - current_tuition_owed   → now the FAMILY TOTAL
--   - recommended_award      → now the FAMILY TOTAL
-- Per-student amounts live on fa_application_students.

CREATE TABLE IF NOT EXISTS fa_application_students (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES fa_applications(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  current_tuition numeric(12, 2),
  requested_aid numeric(12, 2),
  recommended_award numeric(12, 2),
  award_note text,                              -- per-student override note
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_fa_app_students_app
  ON fa_application_students (application_id);
CREATE INDEX IF NOT EXISTS idx_fa_app_students_student
  ON fa_application_students (student_id);

-- Forward-migrate existing per-student rows (the seed app I created
-- earlier) into the child table. Safe to re-run.
INSERT INTO fa_application_students (application_id, student_id, current_tuition, requested_aid, recommended_award)
SELECT id, student_id, current_tuition_owed, requested_aid, recommended_award
FROM fa_applications
WHERE student_id IS NOT NULL
ON CONFLICT (application_id, student_id) DO NOTHING;

-- Drop the per-student unique constraint. Different PG versions named
-- it different things — handle both forms.
ALTER TABLE fa_applications
  DROP CONSTRAINT IF EXISTS fa_applications_school_id_student_id_academic_year_key;
ALTER TABLE fa_applications
  DROP CONSTRAINT IF EXISTS fa_applications_school_id_student_id_academic_year_uniq;

-- Make student_id optional; new apps don't set it (they reference
-- students via the child table). We don't drop the column to avoid
-- breaking any in-flight queries; it'll be removed in a future cleanup.
ALTER TABLE fa_applications ALTER COLUMN student_id DROP NOT NULL;

-- New per-household uniqueness — one application per (school, family, year).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_fa_applications_household
  ON fa_applications (school_id, family_id, academic_year);

-- Updated_at trigger for the child table
CREATE OR REPLACE FUNCTION fa_app_students_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fa_app_students_touch ON fa_application_students;
CREATE TRIGGER fa_app_students_touch
  BEFORE UPDATE ON fa_application_students
  FOR EACH ROW EXECUTE FUNCTION fa_app_students_touch_updated_at();
