-- 098: per-student enrollment-status ledger — powers the "student moved
-- to Enrolled" office notifications (Aug 11 call: alert Anna, Sarah,
-- Sonia, Lexi, Lisa with the student's lead teacher).
--
-- The sync is DELETE+rebuild, so status transitions are invisible
-- without memory. After each school sync we diff current students
-- against this ledger: transition INTO 'enrolled' → email the school's
-- settings.enrollment_notification_emails list. First run for a school
-- seeds the ledger silently (no notification blast).
--
-- Deliberately NO FK to students: the rebuild deletes+reinserts student
-- rows inside the sync transaction; a CASCADE would wipe the ledger's
-- memory every 15 minutes. Rows for students that truly left are pruned
-- by the notifier.

CREATE TABLE IF NOT EXISTS enrollment_status_ledger (
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id uuid NOT NULL,
  student_name text NOT NULL DEFAULT '',
  last_status text NOT NULL DEFAULT '',
  notified_enrolled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (school_id, student_id)
);
