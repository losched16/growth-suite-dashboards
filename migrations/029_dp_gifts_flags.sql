-- Extend dp_gifts with the campaign / response / narrative columns the
-- DonorPerfect "Flags" exports include. Prior imports only kept the
-- bare gift_date + amount + donor identity; this captures the rest.
--
-- Used by scripts/enrich-dp-gifts-flags.py to backfill from a
-- DPMigration*Flags*.csv export.

ALTER TABLE dp_gifts
  ADD COLUMN IF NOT EXISTS solicit_code            TEXT,
  ADD COLUMN IF NOT EXISTS solicit_code_descr      TEXT,
  ADD COLUMN IF NOT EXISTS sub_solicit_code        TEXT,
  ADD COLUMN IF NOT EXISTS sub_solicit_code_descr  TEXT,
  ADD COLUMN IF NOT EXISTS response_code           TEXT,
  ADD COLUMN IF NOT EXISTS narrative               TEXT;

CREATE INDEX IF NOT EXISTS idx_dp_gifts_solicit_code
  ON dp_gifts (school_id, solicit_code)
  WHERE solicit_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dp_gifts_sub_solicit_code
  ON dp_gifts (school_id, sub_solicit_code)
  WHERE sub_solicit_code IS NOT NULL;

COMMENT ON COLUMN dp_gifts.solicit_code      IS 'DonorPerfect SOLICIT_CODE — campaign attribution (e.g. DREAM2024).';
COMMENT ON COLUMN dp_gifts.sub_solicit_code  IS 'DonorPerfect SUB_SOLICIT_CODE — sponsorship tier (e.g. BRONZESPONSOR1000).';
COMMENT ON COLUMN dp_gifts.response_code     IS 'DonorPerfect RESPONSE_CODE — usually 100 = responded.';
COMMENT ON COLUMN dp_gifts.narrative         IS 'DonorPerfect NARRATIVE — relationship notes, touchpoints, donor background.';
