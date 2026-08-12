-- 100: admin time corrections for attendance (Clint, Aug 12: "can an
-- admin overwrite the check in time. I need that ability").
--
-- Events stay append-only in spirit: a correction VOIDS the wrong
-- event(s) (kept forever, stamped who/when) and inserts a replacement
-- manual_override event at the admin-chosen time. The recompute
-- trigger ignores voided rows, so daily_attendance (and everything
-- built on it — dashboards, kiosk, parent portal times) reflects the
-- corrected time immediately.

ALTER TABLE attendance_events
  ADD COLUMN IF NOT EXISTS voided_at timestamptz,
  ADD COLUMN IF NOT EXISTS voided_by_admin_email text;

-- Append-only guard, now with exactly ONE allowed mutation: marking a
-- live row voided (voided_at NULL → set, everything else identical).
CREATE OR REPLACE FUNCTION attendance_events_block_modifications()
RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('is_superuser') = 'on' THEN
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

-- Recompute (same as 091) but voided events no longer count.
CREATE OR REPLACE FUNCTION public.attendance_recompute_daily_row()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  ev_date date;
  ev_student uuid;
  ev_school uuid;
  first_in timestamptz;
  last_in timestamptz;
  last_out timestamptz;
  curbside_today boolean;
  picked_by text;
BEGIN
  ev_student := COALESCE(NEW.student_id, OLD.student_id);
  ev_school  := COALESCE(NEW.school_id,  OLD.school_id);
  ev_date    := (COALESCE(NEW.performed_at, OLD.performed_at) AT TIME ZONE 'America/Phoenix')::date;

  SELECT
    MIN(performed_at) FILTER (WHERE event_type = 'check_in'),
    MAX(performed_at) FILTER (WHERE event_type = 'check_in'),
    MAX(performed_at) FILTER (WHERE event_type = 'check_out'),
    bool_or(curbside),
    (ARRAY_AGG(picked_up_by_name_snapshot ORDER BY performed_at DESC)
       FILTER (WHERE event_type = 'check_out' AND picked_up_by_name_snapshot IS NOT NULL))[1]
    INTO first_in, last_in, last_out, curbside_today, picked_by
  FROM attendance_events
  WHERE student_id = ev_student
    AND school_id  = ev_school
    AND voided_at IS NULL
    AND (performed_at AT TIME ZONE 'America/Phoenix')::date = ev_date;

  INSERT INTO daily_attendance (
    school_id, student_id, date,
    status, first_check_in_at, last_check_in_at, last_check_out_at,
    curbside_pickup, picked_up_by_name, updated_at
  ) VALUES (
    ev_school, ev_student, ev_date,
    CASE
      WHEN first_in IS NULL          THEN 'absent'
      WHEN last_out IS NULL          THEN 'present'
      WHEN last_out > last_in        THEN 'checked_out'
      ELSE                                'present'   -- back in after a mid-day checkout
    END,
    first_in, last_in, last_out,
    COALESCE(curbside_today, false), picked_by, now()
  )
  ON CONFLICT (school_id, student_id, date) DO UPDATE SET
    status            = EXCLUDED.status,
    first_check_in_at = EXCLUDED.first_check_in_at,
    last_check_in_at  = EXCLUDED.last_check_in_at,
    last_check_out_at = EXCLUDED.last_check_out_at,
    curbside_pickup   = EXCLUDED.curbside_pickup,
    picked_up_by_name = EXCLUDED.picked_up_by_name,
    -- A real event supersedes an office-set label (the "Sick" kid who
    -- shows up and checks in becomes present, label gone).
    custom_status        = NULL,
    custom_status_set_at = NULL,
    updated_at        = now();
  RETURN NULL;
END;
$function$;

-- Fire the recompute on the voiding UPDATE too, not just inserts.
DROP TRIGGER IF EXISTS attendance_events_recompute_daily ON attendance_events;
CREATE TRIGGER attendance_events_recompute_daily
  AFTER INSERT OR UPDATE ON attendance_events
  FOR EACH ROW EXECUTE FUNCTION attendance_recompute_daily_row();
