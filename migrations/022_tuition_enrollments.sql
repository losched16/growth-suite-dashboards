-- Payments Phase 6 — family tuition enrollments.
--
-- This is the row that says "Lauren's family is enrolled in the 10-pay
-- plan for Margaret in 2026-27, with add-ons X and Y." It's the link
-- between the catalog (tuition_grids + payment_plans + addons) and the
-- actual invoices that get generated.
--
-- Flow:
--   1. Operator (or parent on an enrollment form) creates the enrollment.
--   2. The installment-generator immediately materializes all invoices
--      for the academic year, dated according to the plan's schedule.
--   3. Each invoice is a normal `invoices` row with source='tuition_plan'
--      and source_ref={enrollment_id, installment_number}. The parent
--      pays them like any other invoice; autopay enrollment applies.
--
-- We don't keep a separate tuition_installments table — the installments
-- ARE the invoices. Querying by source_ref→enrollment_id gives the
-- enrollment's payment schedule.

CREATE TABLE IF NOT EXISTS family_tuition_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  student_id uuid REFERENCES students(id) ON DELETE SET NULL,
  academic_year text NOT NULL,                   -- '2026-27'

  tuition_grid_id uuid NOT NULL REFERENCES tuition_grids(id) ON DELETE RESTRICT,
  payment_plan_id uuid NOT NULL REFERENCES payment_plans(id) ON DELETE RESTRICT,

  -- Captured at enrollment time so changes to the catalog don't
  -- retroactively change what this family was charged.
  annual_tuition_cents int NOT NULL,             -- from tuition_grid.annual_tuition_cents
  plan_discount_basis_points int NOT NULL DEFAULT 0,
  -- Add-ons the parent chose, as [{key, label, amount_cents}].
  addons jsonb NOT NULL DEFAULT '[]'::jsonb,
  total_annual_cents int NOT NULL,               -- discounted tuition + addons sum
  installment_count int NOT NULL,                -- from plan.installment_count
  -- A snapshot of the plan's schedule_template so we can re-generate
  -- without relying on the plan still existing/being unchanged.
  schedule jsonb NOT NULL,                       -- e.g. {"kind":"monthly","months":["08","09",...,"05"]}

  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'completed', 'cancelled')),

  -- Have we materialized invoices for every installment? When true,
  -- the generator skips this row on subsequent passes.
  installments_generated_at timestamptz,

  internal_note text,                            -- operator note
  created_by_email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- One active enrollment per (family, student, year).
  -- student_id NULL means the enrollment is family-level (rare).
  UNIQUE (school_id, family_id, student_id, academic_year)
);

CREATE INDEX IF NOT EXISTS idx_ftenroll_school_year
  ON family_tuition_enrollments (school_id, academic_year, status);

CREATE INDEX IF NOT EXISTS idx_ftenroll_family
  ON family_tuition_enrollments (family_id, academic_year);

-- Reuses the generic touch function from migration 013.
DROP TRIGGER IF EXISTS ftenroll_touch ON family_tuition_enrollments;
CREATE TRIGGER ftenroll_touch
  BEFORE UPDATE ON family_tuition_enrollments
  FOR EACH ROW EXECUTE FUNCTION portal_form_defs_touch_updated_at();

-- ----- invoice ↔ enrollment cross-reference ----------------------------
-- We store the enrollment link in invoices.source_ref jsonb, but a
-- generated column would make it easier to filter. v1: just query via
-- source_ref->>'enrollment_id'.

COMMENT ON TABLE family_tuition_enrollments IS
  'A family''s commitment to a tuition + payment-plan combo for an academic year. Generates a series of invoices.';
