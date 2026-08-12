-- 099: internal per-student notes feed (Aug 11 call: a chronological
-- "Facebook-style" thread where admins + teachers log conversations and
-- observations about a student — the SST use case, but available on
-- every roster dashboard). STAFF-ONLY: the parent portal has no code
-- path that reads this table.
--
-- Deliberately NO FK to students: the sync's DELETE+rebuild would
-- cascade-wipe the feed every 15 minutes (same reasoning as
-- enrollment_status_ledger, migration 098). Student ids are preserved
-- across syncs by the reuse maps, so notes stay attached.

CREATE TABLE IF NOT EXISTS student_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id uuid NOT NULL,
  author_email text NOT NULL DEFAULT '',
  author_name text NOT NULL DEFAULT '',
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_student_notes_feed
  ON student_notes (school_id, student_id, created_at DESC);
