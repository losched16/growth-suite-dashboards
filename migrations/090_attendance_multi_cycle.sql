-- 090: multi-cycle attendance days (in → out for appointment → back in).
--
-- daily_attendance.status compared FIRST check-in vs LAST check-out, so
-- a student who left mid-day and returned stayed 'checked_out' forever.
-- Status is now driven by the LATEST event: last check-out after the
-- last check-in = out; otherwise present. Also records last_check_in_at
-- so UIs can show "back in at 1:15".
--
-- NOTE: applied directly to production on 2026-08-03; this file
-- formalizes the change for fresh environments.

ALTER TABLE daily_attendance ADD COLUMN IF NOT EXISTS last_check_in_at timestamptz;

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
    updated_at        = now();
  RETURN NULL;
END;
$function$;

-- Backfill every existing row with last_check_in_at + corrected status.
UPDATE daily_attendance da SET
  last_check_in_at = agg.last_in,
  status = CASE
    WHEN agg.first_in IS NULL           THEN 'absent'
    WHEN agg.last_out IS NULL           THEN 'present'
    WHEN agg.last_out > agg.last_in     THEN 'checked_out'
    ELSE                                     'present'
  END
FROM (
  SELECT student_id, school_id,
         (performed_at AT TIME ZONE 'America/Phoenix')::date AS d,
         MIN(performed_at) FILTER (WHERE event_type = 'check_in') AS first_in,
         MAX(performed_at) FILTER (WHERE event_type = 'check_in') AS last_in,
         MAX(performed_at) FILTER (WHERE event_type = 'check_out') AS last_out
    FROM attendance_events
   GROUP BY 1, 2, 3
) agg
WHERE agg.student_id = da.student_id
  AND agg.school_id  = da.school_id
  AND agg.d          = da.date;
