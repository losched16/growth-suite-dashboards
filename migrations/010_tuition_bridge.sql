-- TuitionBridge — financial-aid MVP. Per the TuitionBridge scoping doc
-- (Sonnet draft), the full module is multi-tenant with AI document
-- analysis, Stripe app fees, and multi-parent split workflows. This is
-- the cut for the DG demo: a single-tenant submission → review → award
-- decision loop. No payments, no AI assessment, no S3.
--
-- Built against the unified family-graph (NOT the standalone schools/
-- families/students tables from the brief). One application per
-- (school, student, academic_year) — same uniqueness rule.

CREATE TABLE IF NOT EXISTS fa_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  academic_year text NOT NULL,                 -- e.g. '2025-26'

  -- Submission shape — matches the simplified intake form. Full brief
  -- has 1040 / W-2 / Schedule C extraction; we collect the
  -- self-reported numbers here and let the admin verify against uploaded
  -- documents. AI extraction is Wave-5 work.
  household_size integer,
  total_annual_income numeric(12, 2),
  assets_value numeric(12, 2),
  current_tuition_owed numeric(12, 2),
  requested_aid numeric(12, 2),
  special_circumstances text,                  -- free-form narrative
  parent_notes text,

  -- Lifecycle
  --   draft     parent started filling but didn't submit yet
  --   submitted parent submitted; admin needs to review
  --   reviewing admin claimed and is working it
  --   decided   admin set recommended_award + decided_at
  --   withdrawn parent or admin pulled the application
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','reviewing','decided','withdrawn')),

  -- Decision fields (set by admin)
  recommended_award numeric(12, 2),
  decision_note text,
  decided_at timestamptz,
  decided_by text,                              -- operator session user_email

  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (school_id, student_id, academic_year)
);

CREATE INDEX IF NOT EXISTS idx_fa_apps_school_status
  ON fa_applications (school_id, status);
CREATE INDEX IF NOT EXISTS idx_fa_apps_family
  ON fa_applications (family_id);

-- Supporting documents (tax returns, W-2s, custody paperwork, etc).
-- bytea storage to keep parity with parent_uploads — when we wire up
-- S3 in the full version, this becomes a metadata row referencing an
-- object key instead.
CREATE TABLE IF NOT EXISTS fa_application_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES fa_applications(id) ON DELETE CASCADE,
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,

  document_type text,                           -- '1040', 'w2', 'bank_statement', 'other'
  display_name text NOT NULL,
  original_filename text NOT NULL,
  mime_type text NOT NULL,
  size_bytes integer NOT NULL,
  contents bytea NOT NULL,

  uploaded_by_parent_id uuid REFERENCES parents(id) ON DELETE SET NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fa_files_application
  ON fa_application_files (application_id);

-- updated_at trigger so the queue can sort by recency.
CREATE OR REPLACE FUNCTION fa_applications_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fa_apps_touch ON fa_applications;
CREATE TRIGGER fa_apps_touch
  BEFORE UPDATE ON fa_applications
  FOR EACH ROW EXECUTE FUNCTION fa_applications_touch_updated_at();
