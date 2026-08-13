-- 101 HOTFIX: migration 100 rewrote attendance_events_block_modifications
-- from the 012 original and DROPPED the sync-rebuild bypass that
-- migration 085 had added (SET LOCAL app.attendance_rebuild = 'on').
-- Result: every school with attendance events (DGM, MCS) stopped
-- syncing the moment 100 landed — the rebuild's DELETE hit the guard.
--
-- This version is the union of all three behaviors:
--   1. superuser: anything          (012)
--   2. sync rebuild GUC: anything   (085)
--   3. void-stamping UPDATE only    (100 — admin time corrections)
-- Everything else still raises.

CREATE OR REPLACE FUNCTION attendance_events_block_modifications()
RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('is_superuser') = 'on'
     OR current_setting('app.attendance_rebuild', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.voided_at IS NULL AND NEW.voided_at IS NOT NULL
     AND (to_jsonb(OLD) - 'voided_at' - 'voided_by_admin_email')
       = (to_jsonb(NEW) - 'voided_at' - 'voided_by_admin_email') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'attendance_events is append-only — use a manual_override row instead';
END
$$ LANGUAGE plpgsql;
