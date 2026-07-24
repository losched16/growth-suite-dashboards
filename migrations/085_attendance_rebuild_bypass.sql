-- The append-only guard on attendance_events (migration 012) blocks the
-- sync's preserve/restore rebuild: the rebuild must DELETE the school's
-- events before deleting students (student_id FK is ON DELETE RESTRICT)
-- and re-insert them afterward. Without a bypass, any school that uses
-- the kiosk stops syncing entirely — DGM went 24h stale the day
-- curbside launched.
--
-- The bypass is a TRANSACTION-LOCAL setting only the sync sets
-- (SET LOCAL app.attendance_rebuild = 'on'); it evaporates at commit,
-- so the append-only rule stays enforced for every other code path.

CREATE OR REPLACE FUNCTION attendance_events_block_modifications()
RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('is_superuser') = 'on'
     OR current_setting('app.attendance_rebuild', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'attendance_events is append-only — use a manual_override row instead';
END
$$ LANGUAGE plpgsql;
