-- FACTS CSV import bookkeeping. Two tables:
--
-- 1. school_facts_import_mappings — per-school column mapping that
--    persists across imports. School uploads their first FACTS CSV,
--    operator maps columns once, mapping is reused next time.
--
-- 2. school_facts_imports — audit log per import run. Stores raw CSV
--    + parsed rows + outcome counts. Useful for "what changed in
--    yesterday's import" investigations.

CREATE TABLE IF NOT EXISTS school_facts_import_mappings (
  school_id      uuid PRIMARY KEY REFERENCES schools(id) ON DELETE CASCADE,
  -- JSONB shape: { "<our_schema_field>": "<their_csv_header>" }
  -- Example:
  --   {
  --     "family_id":      "Account Number",
  --     "student_first":  "Student First Name",
  --     "student_last":   "Student Last Name",
  --     "annual_tuition": "Annual Tuition",
  --     "plan":           "Payment Plan",
  --     "sibling_discount": "Sibling Discount",
  --     ...
  --   }
  field_mapping  jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Convenience defaults: what plan slug to assume when the CSV's
  -- plan-text matches a value (e.g. "Monthly" → "monthly"). Helps
  -- normalize across schools' different naming conventions.
  plan_name_aliases jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Academic year this mapping applies to (so next year's mapping
  -- can override if the FACTS export changes shape).
  academic_year  text,
  last_used_at   timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS school_facts_imports (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id      uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  academic_year  text NOT NULL,
  -- Operator who initiated the import (email from operator session)
  initiated_by   text,

  -- Raw + parsed + results
  raw_csv        text,             -- compressed/truncated for large files
  headers        text[],
  total_rows     integer NOT NULL DEFAULT 0,
  rows_matched   integer NOT NULL DEFAULT 0,
  rows_inserted  integer NOT NULL DEFAULT 0,
  rows_updated   integer NOT NULL DEFAULT 0,
  rows_skipped   integer NOT NULL DEFAULT 0,
  rows_errored   integer NOT NULL DEFAULT 0,

  -- Per-row outcome log
  row_log        jsonb NOT NULL DEFAULT '[]'::jsonb,
  field_mapping_used jsonb,

  status         text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'previewing', 'committed', 'failed', 'aborted')),

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS school_facts_imports_by_school
  ON school_facts_imports (school_id, created_at DESC);

COMMENT ON TABLE school_facts_import_mappings IS
  'Per-school CSV column → our-schema field mapping. Persists across imports so DGM (etc.) configure once, then re-run yearly.';
COMMENT ON TABLE school_facts_imports IS
  'Audit log of every FACTS import run. Stores raw CSV + per-row outcome so we can debug "what changed today."';
