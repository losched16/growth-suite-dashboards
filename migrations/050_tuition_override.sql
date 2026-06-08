-- Per-enrollment tuition override. Lets a school override the computed
-- "grid + plan discount + addons = total" with an arbitrary dollar
-- amount — for scholarships, financial-aid awards, custom one-family
-- adjustments, sibling discounts not modeled in the discount engine,
-- etc.
--
-- When tuition_override_cents IS NOT NULL, the tuition plan generator
-- uses that value as total_annual_cents (so installments are computed
-- against the override, not the grid). A value of 0 means "this family
-- owes nothing" — generator still records the enrollment but skips
-- materializing any invoices.
--
-- All four fields are nullable (default behavior = no override; tuition
-- computed normally). Once an override is set, the audit columns
-- capture WHO set it and WHEN — useful when scholarships need to be
-- documented for the board or auditors.

ALTER TABLE family_tuition_enrollments
  ADD COLUMN IF NOT EXISTS tuition_override_cents       integer NULL,
  ADD COLUMN IF NOT EXISTS tuition_override_reason      text NULL,
  ADD COLUMN IF NOT EXISTS tuition_override_set_by_email text NULL,
  ADD COLUMN IF NOT EXISTS tuition_override_set_at      timestamptz NULL;

COMMENT ON COLUMN family_tuition_enrollments.tuition_override_cents IS
  'Override the computed total_annual_cents. NULL = no override (compute from grid+plan+addons). 0 = scholarship (family owes nothing, no invoices generated). >0 = set to this exact dollar amount, split across the plan installments.';
