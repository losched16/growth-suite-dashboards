-- Portal Forms Engine. Generic form-definitions table + submissions
-- + file attachments + per-student Health Profile (used as pre-fill
-- source for trip / medical / permission forms).
--
-- Design highlights:
--   - Form schemas live in JSONB (portal_form_definitions.field_schema)
--     so adding a new form is a config row, not new code.
--   - Submissions row carries the full response payload + scope
--     (school, family, parent, student) for filtering.
--   - Per-student forms set student_id on the submission. Per-family
--     forms leave student_id NULL.
--   - portal_form_submission_files mirrors fa_application_files /
--     parent_uploads — bytea + metadata, served via a guarded route.
--   - student_health_profiles holds the per-student medical / emergency
--     contact data that trip forms pre-fill from. Parent updates it
--     once, every trip form reads from it.

CREATE TABLE IF NOT EXISTS portal_form_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,

  slug text NOT NULL,                          -- 'cafe-worker-permission'
  display_name text NOT NULL,
  description text,                            -- intro paragraph shown to parent

  category text,                               -- 'permission'/'trip'/'medical'/'registration'/'release'
  per_student boolean NOT NULL DEFAULT false,  -- true → student selector at top
  required_for text,                           -- 'all'/'new-families'/'grade:k'/'program:LE' etc.
                                                -- (free-form for now; admin filters off this)
  is_active boolean NOT NULL DEFAULT true,     -- toggle to hide from parents

  -- Field schema. Array of objects; each has at minimum {type} and
  -- often {key, label, required, prefill, options, validation}.
  -- See lib/forms/types.ts for the discriminated-union TypeScript shape.
  field_schema jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- GHL writeback: array of {field_key (form), ghl_field_key (target),
  -- per_student (bool)}. The submit endpoint reads this and writes the
  -- form values into the parent's GHL contact custom fields.
  ghl_writeback jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Submission rules
  one_submission_per_year boolean NOT NULL DEFAULT true,
  resubmission_allowed boolean NOT NULL DEFAULT false,   -- after a final submit, allow edits?
  fee_amount numeric(10, 2),                              -- if non-null, this form has a fee (Stripe later)

  -- Admin note. Show in admin UI; not visible to parents.
  admin_notes text,

  -- Provenance for the "this form definition needs human verification"
  -- workflow. We seed many forms based on form-name guesses; operator
  -- reviews before flipping is_active=true.
  needs_review boolean NOT NULL DEFAULT false,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (school_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_portal_form_defs_school
  ON portal_form_definitions (school_id, is_active, category);

-- updated_at trigger
CREATE OR REPLACE FUNCTION portal_form_defs_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS portal_form_defs_touch ON portal_form_definitions;
CREATE TRIGGER portal_form_defs_touch
  BEFORE UPDATE ON portal_form_definitions
  FOR EACH ROW EXECUTE FUNCTION portal_form_defs_touch_updated_at();


CREATE TABLE IF NOT EXISTS portal_form_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  form_definition_id uuid NOT NULL REFERENCES portal_form_definitions(id) ON DELETE CASCADE,

  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  parent_id uuid NOT NULL REFERENCES parents(id) ON DELETE SET NULL,
  student_id uuid REFERENCES students(id) ON DELETE SET NULL,   -- null for per-family forms

  academic_year text NOT NULL DEFAULT '2025-26',

  -- The actual response data. Keyed by field_schema[i].key.
  -- Signatures (typed-name + acknowledged-date OR drawn PNG data URL)
  -- live here too — drawn signatures are stored as base64 strings.
  responses jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Submission lifecycle
  status text NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('draft', 'submitted', 'pending_payment', 'paid', 'voided')),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  voided_by_admin_email text,
  voided_reason text,

  -- GHL writeback status
  ghl_synced_at timestamptz,
  ghl_sync_error text,

  -- Payment (placeholder until Stripe wired)
  fee_amount_charged numeric(10, 2),
  payment_status text,                          -- 'unpaid'/'pending'/'paid'/'refunded'
  payment_reference text,

  -- Audit
  ip_address text,
  user_agent text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Helpful index: latest submission per (family, student, form, year)
CREATE INDEX IF NOT EXISTS idx_portal_form_subs_school
  ON portal_form_submissions (school_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_portal_form_subs_form
  ON portal_form_submissions (form_definition_id, student_id);
CREATE INDEX IF NOT EXISTS idx_portal_form_subs_family
  ON portal_form_submissions (family_id, academic_year);
CREATE INDEX IF NOT EXISTS idx_portal_form_subs_completion
  ON portal_form_submissions (school_id, form_definition_id, academic_year, student_id)
  WHERE status IN ('submitted', 'paid');

-- updated_at trigger
DROP TRIGGER IF EXISTS portal_form_subs_touch ON portal_form_submissions;
CREATE TRIGGER portal_form_subs_touch
  BEFORE UPDATE ON portal_form_submissions
  FOR EACH ROW EXECUTE FUNCTION portal_form_defs_touch_updated_at();


-- File uploads attached to submissions
CREATE TABLE IF NOT EXISTS portal_form_submission_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES portal_form_submissions(id) ON DELETE CASCADE,
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  field_key text NOT NULL,                      -- which schema field this file is for
  display_name text NOT NULL,
  original_filename text NOT NULL,
  mime_type text NOT NULL,
  size_bytes integer NOT NULL,
  contents bytea NOT NULL,
  uploaded_by_parent_id uuid REFERENCES parents(id) ON DELETE SET NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_portal_form_sub_files_sub
  ON portal_form_submission_files (submission_id);


-- Per-student health profile. Trip / medical / permission forms pre-fill
-- emergency contact + meds + allergies + doctor info from here.
-- Updated by the parent on first trip form (or via a standalone Health
-- Profile page); subsequent trip forms read from this and let parent
-- confirm or edit the deltas.
CREATE TABLE IF NOT EXISTS student_health_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,

  -- Emergency contact (in addition to parents)
  emergency_contact_name text,
  emergency_contact_relationship text,
  emergency_contact_phone text,
  emergency_contact_alt_phone text,

  -- Medical
  primary_doctor_name text,
  primary_doctor_phone text,
  preferred_hospital text,
  health_insurance_provider text,
  health_insurance_policy_number text,

  allergies text,                                -- free-form list
  current_medications text,                      -- free-form list
  medical_conditions text,                       -- free-form

  -- Permissions on file
  can_take_otc_medication boolean,
  can_apply_sunscreen boolean,
  can_apply_insect_repellent boolean,
  can_be_transported_by_school boolean,

  -- Last review by parent
  reviewed_by_parent_id uuid REFERENCES parents(id) ON DELETE SET NULL,
  reviewed_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (school_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_student_health_profiles_school
  ON student_health_profiles (school_id);

-- updated_at trigger
DROP TRIGGER IF EXISTS student_health_profiles_touch ON student_health_profiles;
CREATE TRIGGER student_health_profiles_touch
  BEFORE UPDATE ON student_health_profiles
  FOR EACH ROW EXECUTE FUNCTION portal_form_defs_touch_updated_at();
