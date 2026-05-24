-- People who are NOT allowed to pick up a given student. Distinct from
-- pickup_persons (which is the AUTHORIZED list). Operator-managed —
-- typically populated from custody-paperwork conversations with the
-- family. Shown on the teacher's classroom dashboard so they know who
-- to refuse if someone tries to collect a student at pickup.

CREATE TABLE IF NOT EXISTS student_pickup_restrictions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id     uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id    uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,

  person_name   text NOT NULL,
  relationship  text,
  reason        text,
  notes         text,

  active        boolean NOT NULL DEFAULT true,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pickup_restrictions_student
  ON student_pickup_restrictions (student_id, active);
CREATE INDEX IF NOT EXISTS idx_pickup_restrictions_school
  ON student_pickup_restrictions (school_id, active);

COMMENT ON TABLE student_pickup_restrictions IS
  'People barred from picking up a specific student. Sensitive data — show only on operator + teacher dashboards, never to parents.';
