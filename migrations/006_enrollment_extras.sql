-- Add fields needed by the rich Enrollment Hub:
--   enrollments.schedule       — "School Day" / "Extended Day" / etc.
--   classrooms.lead_teacher_name — homeroom teacher display name
--
-- Both nullable. Sync populates them from per-student GHL fields
-- (daily_schedule, lead_teacher) — for any school whose field schema
-- maps those keys. Schools that don't track them simply leave the
-- columns NULL and the corresponding widget filter shows no data.

ALTER TABLE enrollments
  ADD COLUMN IF NOT EXISTS schedule text;

CREATE INDEX IF NOT EXISTS idx_enrollments_schedule
  ON enrollments (school_id, schedule)
  WHERE schedule IS NOT NULL;

ALTER TABLE classrooms
  ADD COLUMN IF NOT EXISTS lead_teacher_name text;
