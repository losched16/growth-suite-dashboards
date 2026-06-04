-- 045_pickup_persons_per_student.sql
--
-- Two changes that let pickup people be scoped to specific students:
--
-- 1) pickup_persons.family_id (new column, denormalized from parents)
--    - Enables the unique constraint below — Postgres can't enforce
--      uniqueness across a join.
--    - Backfilled from parents.family_id at migration time. Going
--      forward, the parent portal's add-pickup-person handler sets it
--      directly.
--
-- 2) pickup_person_students (new junction table)
--    - One row per (pickup_person, student) authorization.
--    - When a pickup person has NO rows in this table, the convention
--      is "authorized for every student in the family" (back-compat
--      for existing rows from before this migration).
--    - When the table has 1+ rows for a person, only the listed
--      students can be picked up by them.
--
-- 3) UNIQUE (school_id, family_id, lower(name))
--    - Prevents Rachel's "I added Grandma twice by accident" problem
--      going forward. Combined with the dedupe script that runs
--      against existing data, Wooster will be clean.

BEGIN;

-- 1) Denormalize family_id onto pickup_persons --------------------
ALTER TABLE pickup_persons
  ADD COLUMN IF NOT EXISTS family_id uuid;

-- Backfill from the adder's family. Every existing row has an
-- added_by_parent_id pointing at a parent row; that parent has a
-- family_id we copy across.
UPDATE pickup_persons pp
   SET family_id = p.family_id
  FROM parents p
 WHERE p.id = pp.added_by_parent_id
   AND pp.family_id IS NULL;

-- Now enforce: every pickup person belongs to exactly one family.
ALTER TABLE pickup_persons
  ALTER COLUMN family_id SET NOT NULL,
  ADD CONSTRAINT pickup_persons_family_fk
    FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS pickup_persons_family_idx
  ON pickup_persons(family_id);

-- 2) Junction table ----------------------------------------------
CREATE TABLE IF NOT EXISTS pickup_person_students (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pickup_person_id   uuid NOT NULL REFERENCES pickup_persons(id) ON DELETE CASCADE,
  student_id         uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  school_id          uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pickup_person_students_unique UNIQUE (pickup_person_id, student_id)
);

CREATE INDEX IF NOT EXISTS pickup_person_students_person_idx
  ON pickup_person_students(pickup_person_id);

CREATE INDEX IF NOT EXISTS pickup_person_students_student_idx
  ON pickup_person_students(student_id);

COMMENT ON TABLE pickup_person_students IS
  'Per-student authorization for pickup_persons. Empty table for a given pickup_person = authorized for every student in that family (back-compat default).';

-- 3) Dedup-prevention unique constraint --------------------------
-- We use a partial unique index keyed on lower(name) so case
-- variations ("Grandma Jo" vs "grandma jo") collapse. Only enforce
-- on active rows so a deactivated row + a re-add doesn't trip it.
CREATE UNIQUE INDEX IF NOT EXISTS pickup_persons_no_dupes_active
  ON pickup_persons(school_id, family_id, lower(name))
  WHERE active = true;

COMMIT;
