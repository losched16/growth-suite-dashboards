-- Broaden the daily_attendance.curbside_pickup computation to include
-- ANY event with curbside=true, not just check_out. Lets a parent flag
-- "today is a curbside pickup day" at MORNING DROP-OFF (check_in) so
-- teachers see it on the roster before the afternoon.
--
-- Original trigger (migration 012) only considered check_out events.

CREATE OR REPLACE FUNCTION attendance_recompute_daily_row()
RETURNS TRIGGER AS $$
DECLARE
  ev_date date;
  ev_student uuid;
  ev_school uuid;
  first_in timestamptz;
  last_out timestamptz;
  curbside_today boolean;
  picked_by text;
BEGIN
  ev_student := COALESCE(NEW.student_id, OLD.student_id);
  ev_school  := COALESCE(NEW.school_id,  OLD.school_id);
  ev_date    := (COALESCE(NEW.performed_at, OLD.performed_at) AT TIME ZONE 'America/Phoenix')::date;

  SELECT
    MIN(performed_at) FILTER (WHERE event_type = 'check_in'),
    MAX(performed_at) FILTER (WHERE event_type = 'check_out'),
    bool_or(curbside),  -- ANY event with curbside=true marks the day curbside
    (ARRAY_AGG(picked_up_by_name_snapshot ORDER BY performed_at DESC)
       FILTER (WHERE event_type = 'check_out' AND picked_up_by_name_snapshot IS NOT NULL))[1]
    INTO first_in, last_out, curbside_today, picked_by
  FROM attendance_events
  WHERE student_id = ev_student
    AND school_id  = ev_school
    AND (performed_at AT TIME ZONE 'America/Phoenix')::date = ev_date;

  INSERT INTO daily_attendance (
    school_id, student_id, date,
    status, first_check_in_at, last_check_out_at,
    curbside_pickup, picked_up_by_name, updated_at
  ) VALUES (
    ev_school, ev_student, ev_date,
    CASE
      WHEN first_in IS NULL                          THEN 'absent'
      WHEN last_out IS NULL                          THEN 'present'
      WHEN last_out > first_in                       THEN 'checked_out'
      ELSE                                                 'partial'
    END,
    first_in, last_out,
    COALESCE(curbside_today, false), picked_by, now()
  )
  ON CONFLICT (school_id, student_id, date) DO UPDATE SET
    status            = EXCLUDED.status,
    first_check_in_at = EXCLUDED.first_check_in_at,
    last_check_out_at = EXCLUDED.last_check_out_at,
    curbside_pickup   = EXCLUDED.curbside_pickup,
    picked_up_by_name = EXCLUDED.picked_up_by_name,
    updated_at        = now();
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
