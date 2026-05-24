-- School-editable notes on a donor record, distinct from any data that
-- came in from a DonorPerfect import. The DP import scripts MUST NOT
-- touch this column — that's the whole point: an operator can write
-- notes here without worrying about them getting clobbered on the next
-- DP re-sync.
--
-- Surface: the donor accordion on the Donors dashboard. POST'd to
-- /api/school/donor-notes/save.

ALTER TABLE dp_donors
  ADD COLUMN IF NOT EXISTS school_notes        TEXT,
  ADD COLUMN IF NOT EXISTS school_notes_updated_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS school_notes_updated_by  TEXT;

COMMENT ON COLUMN dp_donors.school_notes
  IS 'Operator-editable free-form notes. Never overwritten by DonorPerfect imports.';
