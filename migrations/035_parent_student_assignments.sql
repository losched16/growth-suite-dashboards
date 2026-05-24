-- Many-to-many between parents and students within a family. Supports
-- blended / divorced / step-family arrangements where one kid in the
-- family is parented by Mom + Dad and another kid in the same family
-- is parented by Mom + Stepdad.
--
-- Back-compat: if no rows exist for a parent, treat as "this parent
-- applies to every student in the family" (the historical default).
-- That keeps every existing family working unchanged until a parent
-- explicitly opts in to per-student assignments.

CREATE TABLE IF NOT EXISTS parent_student_assignments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  parent_id   uuid NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  student_id  uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  -- Per-child relationship label. The parents table has a single role
  -- field, but in blended families a parent's relationship can differ
  -- per kid (e.g. "Mother" to kid A, "Stepmother" to kid B). Free-text
  -- so schools can label however they prefer.
  relationship text,
  -- True for the kid's primary caregiver. Used by attendance, billing,
  -- and emergency-contact ordering. Multiple parents can be primary on
  -- different kids in the same family; only one primary per kid is
  -- enforced (partial unique index below).
  is_primary_for_student boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (parent_id, student_id)
);

-- Only one primary-caregiver parent per student. The partial unique
-- index lets us still have multiple non-primary parents per kid.
CREATE UNIQUE INDEX IF NOT EXISTS parent_student_assignments_one_primary_per_student
  ON parent_student_assignments (student_id)
  WHERE is_primary_for_student = true;

CREATE INDEX IF NOT EXISTS parent_student_assignments_by_parent
  ON parent_student_assignments (parent_id);

CREATE INDEX IF NOT EXISTS parent_student_assignments_by_student
  ON parent_student_assignments (student_id);

COMMENT ON TABLE parent_student_assignments IS
  'Optional per-student parent assignment. Empty for a parent → that parent applies to every student in their family (back-compat).';
