-- Per-school GHL field-schema config. Lets the GHL→family-graph sync
-- support multiple schools without code changes — the field key mappings
-- are stored as JSONB and edited via the operator admin UI.
--
-- One row per school. Schools without a row fall back to a built-in
-- "Desert Garden Montessori" preset (lib/sync/desert-garden-config.ts)
-- so existing schools keep working with zero migration effort.

CREATE TABLE IF NOT EXISTS school_field_schemas (
  school_id uuid PRIMARY KEY REFERENCES schools(id) ON DELETE CASCADE,

  -- Family-level custom fields (one per family/contact)
  --   { householdId: 'household_id', language: 'language', activeStatus: 'active_inactive', ... }
  family_fields jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Parent 2 fields (parent 1 lives on standard contact firstName/lastName/email/phone)
  --   { firstName: 'parent_2_first_name', lastName: 'parent_2_last_name', ... }
  parent2_fields jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Per-student fields. Keyed by abstract name; values are the bare key
  -- (no slot prefix). Sync builds the actual key as
  --   slot 1: "student_<base>"
  --   slot N: "student_<N>_<base>"
  student_fields jsonb NOT NULL DEFAULT '{}'::jsonb,

  max_student_slots integer NOT NULL DEFAULT 4 CHECK (max_student_slots BETWEEN 1 AND 10),
  default_academic_year text NOT NULL DEFAULT '2026-27',

  -- Free-form notes for the operator (e.g. "uses Smart Forms intake, custom homeroom values")
  notes text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION school_field_schemas_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS school_field_schemas_updated_at ON school_field_schemas;
CREATE TRIGGER school_field_schemas_updated_at
  BEFORE UPDATE ON school_field_schemas
  FOR EACH ROW EXECUTE FUNCTION school_field_schemas_set_updated_at();
