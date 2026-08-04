-- 091: office-defined custom attendance statuses ("Field Trip", "Sick",
-- "Late" …). Categories live in schools.settings.attendance_custom_statuses
-- ([{key,label,color}], self-serve managed from the Attendance dashboard);
-- the per-student-per-day assignment lives here. A custom status is a
-- display OVERRIDE: the event-derived status keeps computing underneath,
-- and any real check-in/out event AFTER the custom status was set clears
-- it (kid marked "Sick" who shows up and checks in flips to present
-- automatically).

ALTER TABLE daily_attendance
  ADD COLUMN IF NOT EXISTS custom_status text,
  ADD COLUMN IF NOT EXISTS custom_status_set_at timestamptz;

-- Same trigger as 090 plus: a new event wipes the custom label.
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
