-- 047_fa_ai_analysis.sql
--
-- Cache Claude-generated FA analyses on the application row so the
-- queue UI doesn't re-burn API tokens every time someone opens the
-- detail panel. Operator can regenerate from the UI.

BEGIN;

ALTER TABLE fa_applications
  ADD COLUMN IF NOT EXISTS ai_analysis        jsonb,
  ADD COLUMN IF NOT EXISTS ai_analyzed_at     timestamptz,
  ADD COLUMN IF NOT EXISTS ai_analysis_model  text;

COMMENT ON COLUMN fa_applications.ai_analysis IS
  'Structured Claude analysis: { executive_summary, financial_snapshot, positives[], concerns[], recommended_awards[{student_id, low_cents, high_cents, rationale}], suggested_decision_note, total_award_range }';

COMMIT;
