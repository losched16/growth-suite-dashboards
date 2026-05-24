-- Attendance check-in / check-out for Desert Garden (and beyond).
-- Reuses the unified family-graph: parents, students, families, schools
-- already exist and are multi-tenant. This migration only adds:
--   - pickup_persons       (family-managed authorized pickup list)
--   - attendance_events    (append-only event log)
--   - daily_attendance     (per-student-per-day rollup for fast reads)
--
-- Append-only invariant on attendance_events is enforced at the
-- application layer (no UPDATE/DELETE codepaths) and via a row-level
-- trigger that blocks updates/deletes for non-superuser sessions.
-- Corrections are new event rows with event_type = 'manual_override'
-- referencing the original event id in `notes`.

-- ----- pickup_persons -------------------------------------------------
-- Family-managed list of non-parent adults authorized to pick up students.
-- Owned by a parent; shared with their family via family_members.
-- Both parents in a household see the same pool.
CREATE TABLE IF NOT EXISTS pickup_persons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  added_by_parent_id uuid NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  name text NOT NULL,
  relationship text NOT NULL,           -- 'Grandparent', 'Nanny', 'Aunt', etc.
  phone text,
  notes text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pickup_persons_school
  ON pickup_persons (school_id);
CREATE INDEX IF NOT EXISTS idx_pickup_persons_added_by
  ON pickup_persons (added_by_parent_id) WHERE active = true;

-- ----- attendance_events (APPEND-ONLY) --------------------------------
CREATE TABLE IF NOT EXISTS attendance_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE RESTRICT,

  -- 'check_in' | 'check_out' | 'absent' | 'manual_override'
  event_type text NOT NULL CHECK (event_type IN ('check_in','check_out','absent','manual_override')),

  -- Actor (one of these will be set; both nullable for absent-by-system if added later)
  performed_by_parent_id uuid REFERENCES parents(id) ON DELETE SET NULL,
  performed_by_admin_email text,        -- admin acting from the iframe; no admin_users table yet

  -- Who actually picked the student up (only meaningful for check_out)
  picked_up_by_parent_id uuid REFERENCES parents(id) ON DELETE SET NULL,
  picked_up_by_pickup_person_id uuid REFERENCES pickup_persons(id) ON DELETE SET NULL,
  picked_up_by_name_snapshot text,      -- denormalized at event time (survives deactivation)

  performed_at timestamptz NOT NULL DEFAULT now(),
  signature_png text,                   -- data URL: 'data:image/png;base64,...'
  curbside boolean NOT NULL DEFAULT false,
  notes text,

  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_attendance_events_school_date
  ON attendance_events (school_id, performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_events_student_date
  ON attendance_events (student_id, performed_at DESC);
-- Note: a (school_id, performed_at::date, event_type) index would help
-- the "today" query but `::date` isn't IMMUTABLE in Postgres (timezone-
-- dependent). For now the school_id+performed_at index above is enough
-- — typical school is <500 events/day so a range scan is fast.

-- Append-only guard: block UPDATE and DELETE at the row level.
-- Lets superuser through (for migrations / data fixes).
CREATE OR REPLACE FUNCTION attendance_events_block_modifications()
RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('is_superuser') = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'attendance_events is append-only — use a manual_override row instead';
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS attendance_events_no_update ON attendance_events;
CREATE TRIGGER attendance_events_no_update
  BEFORE UPDATE ON attendance_events
  FOR EACH ROW EXECUTE FUNCTION attendance_events_block_modifications();

DROP TRIGGER IF EXISTS attendance_events_no_delete ON attendance_events;
CREATE TRIGGER attendance_events_no_delete
  BEFORE DELETE ON attendance_events
  FOR EACH ROW EXECUTE FUNCTION attendance_events_block_modifications();

-- ----- daily_attendance (rollup) --------------------------------------
-- One row per (school, student, date). Recomputed by trigger on every
-- new attendance_events insert. Cheap to recompute since events are
-- ~2-4 per day per student.
CREATE TABLE IF NOT EXISTS daily_attendance (
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  date date NOT NULL,
  status text NOT NULL CHECK (status IN ('present','absent','partial','not_yet','checked_out')),
  first_check_in_at timestamptz,
  last_check_out_at timestamptz,
  total_minutes int,
  curbside_pickup boolean,
  picked_up_by_name text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (school_id, student_id, date)
);

CREATE INDEX IF NOT EXISTS idx_daily_attendance_school_date
  ON daily_attendance (school_id, date);

-- Auto-recompute daily_attendance after each event insert.
-- "Today" is computed in the school's timezone — for the MVP we use
-- America/Phoenix (DG's timezone). When we ship multi-tenant we'll
-- read schools.timezone.
CREATE OR REPLACE FUNCTION attendance_recompute_daily_row()
RETURNS TRIGGER AS $$
DECLARE
  ev_date date;
  first_in timestamptz;
  last_out timestamptz;
  curbside_today boolean;
  picked_by text;
  computed_status text;
  total_min int;
BEGIN
  ev_date := (NEW.performed_at AT TIME ZONE 'America/Phoenix')::date;

  SELECT MIN(performed_at) FILTER (WHERE event_type = 'check_in'),
         MAX(performed_at) FILTER (WHERE event_type = 'check_out'),
         bool_or(curbside) FILTER (WHERE event_type = 'check_out'),
         (array_agg(picked_up_by_name_snapshot ORDER BY performed_at DESC)
            FILTER (WHERE event_type = 'check_out'))[1]
    INTO first_in, last_out, curbside_today, picked_by
    FROM attendance_events
    WHERE student_id = NEW.student_id
      AND (performed_at AT TIME ZONE 'America/Phoenix')::date = ev_date
      AND event_type IN ('check_in','check_out');

  IF first_in IS NULL THEN
    -- Could be an `absent` or `manual_override` event with no check_in
    computed_status := 'absent';
    total_min := NULL;
  ELSIF last_out IS NULL THEN
    computed_status := 'present';
    total_min := EXTRACT(EPOCH FROM (now() - first_in))::int / 60;
  ELSE
    computed_status := 'checked_out';
    total_min := EXTRACT(EPOCH FROM (last_out - first_in))::int / 60;
  END IF;

  INSERT INTO daily_attendance (
    school_id, student_id, date, status,
    first_check_in_at, last_check_out_at, total_minutes,
    curbside_pickup, picked_up_by_name, updated_at
  ) VALUES (
    NEW.school_id, NEW.student_id, ev_date, computed_status,
    first_in, last_out, total_min,
    COALESCE(curbside_today, false), picked_by, now()
  )
  ON CONFLICT (school_id, student_id, date) DO UPDATE SET
    status            = EXCLUDED.status,
    first_check_in_at = EXCLUDED.first_check_in_at,
    last_check_out_at = EXCLUDED.last_check_out_at,
    total_minutes     = EXCLUDED.total_minutes,
    curbside_pickup   = EXCLUDED.curbside_pickup,
    picked_up_by_name = EXCLUDED.picked_up_by_name,
    updated_at        = now();
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS attendance_events_recompute_daily ON attendance_events;
CREATE TRIGGER attendance_events_recompute_daily
  AFTER INSERT ON attendance_events
  FOR EACH ROW EXECUTE FUNCTION attendance_recompute_daily_row();

-- ----- updated_at trigger for pickup_persons --------------------------
CREATE OR REPLACE FUNCTION pickup_persons_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pickup_persons_touch ON pickup_persons;
CREATE TRIGGER pickup_persons_touch
  BEFORE UPDATE ON pickup_persons
  FOR EACH ROW EXECUTE FUNCTION pickup_persons_touch_updated_at();
