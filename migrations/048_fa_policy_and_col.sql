-- 048_fa_policy_and_col.sql
--
-- Per-school FA policy caps + cost-of-living signal. The analyzer
-- computes Claude's unrestricted recommendation first, then applies
-- the school's hard policy ceilings to produce the final number the
-- committee sees. Both numbers + the explanation are persisted so
-- the audit trail is clear.

BEGIN;

ALTER TABLE school_financial_aid_settings
  -- Hard policy caps (NULL = no cap).
  --
  -- max_award_pct_of_tuition: 0.50 means "no award exceeds 50% of
  -- the student's tuition." Most schools live in 0.40 – 0.75.
  --
  -- min_family_contribution_pct: 0.20 means "family always pays at
  -- least 20% of tuition." Complements the cap above — gives Claude
  -- a floor on family responsibility, not just a ceiling on aid.
  --
  -- max_award_per_student_cents already exists; treat as the dollar
  -- equivalent of max_award_pct_of_tuition. The analyzer takes the
  -- tighter of the three constraints.
  ADD COLUMN IF NOT EXISTS max_award_pct_of_tuition    numeric(5, 4),
  ADD COLUMN IF NOT EXISTS min_family_contribution_pct numeric(5, 4),
  ADD COLUMN IF NOT EXISTS policy_notes                text,

  -- Cost-of-living context. The wizard already captures the family's
  -- ACTUAL housing/medical/childcare costs, so we don't need a
  -- formula — but we do let the school flag their region so Claude
  -- can sanity-check ("$2,500 housing in this area is reasonable"
  -- vs. "$2,500 housing in rural Arkansas is high").
  --
  -- regional_col_multiplier: 1.0 = US average. >1 = above-average
  -- COL area (high housing/childcare costs). <1 = below-average.
  -- Claude uses it to adjust expectations of what a "reasonable"
  -- expense profile looks like for this school's region.
  ADD COLUMN IF NOT EXISTS regional_col_multiplier     numeric(4, 2)  DEFAULT 1.00,
  ADD COLUMN IF NOT EXISTS regional_col_label          text;

COMMENT ON COLUMN school_financial_aid_settings.max_award_pct_of_tuition IS
  'Hard cap as a fraction of each student''s tuition (e.g. 0.50 = no award > 50%). NULL = no cap. Applied AFTER Claude''s unrestricted recommendation.';

COMMENT ON COLUMN school_financial_aid_settings.regional_col_multiplier IS
  'Cost-of-living factor relative to US average (1.0). Claude uses this to assess whether the family''s reported expenses are reasonable for the region.';

COMMIT;
