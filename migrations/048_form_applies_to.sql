-- portal_form_definitions.applies_to JSONB
--
-- Optional per-form visibility rule. When NULL (default), the form
-- applies to every student in the family — current behavior. When set,
-- the parent portal hub + form detail page restrict the form to
-- students matching ANY of the OR-ed criteria.
--
-- Schema (validated in code, not in the DB):
--   {
--     "tuition_grid_match": ["kindergarten"],         -- case-ins. substring on tuition_grids.display_name
--     "program_match":      ["young community"],       -- case-ins. substring on students.metadata.program
--     "metadata_match":     { "aftercare": ["before","after","both","full"] },  -- key → allowed values
--     "addon_keys":         ["extended_care"]          -- exact match on enrollment.addons[].key
--   }
--
-- The criteria are OR'd: a student is shown the form if they satisfy
-- at least one. Empty / missing keys are ignored. NULL applies_to
-- means "every student" — backward compatible for every existing form.
--
-- Examples (MCH 2026-27):
--   Act 90 textbook request:  { tuition_grid_match: ["kindergarten"] }
--   Dental exam (Act 28):     { tuition_grid_match: ["kindergarten"] }
--   DHS Extended Care:        { program_match: ["young community"],
--                                metadata_match: { aftercare: ["before","after","both","full"] } }

ALTER TABLE portal_form_definitions
  ADD COLUMN IF NOT EXISTS applies_to JSONB DEFAULT NULL;

COMMENT ON COLUMN portal_form_definitions.applies_to IS
  'Per-student visibility rule. NULL = show for every student in the family. See lib/forms/applies-to.ts for the rule schema. OR semantics across the listed criteria.';
