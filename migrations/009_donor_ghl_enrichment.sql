-- Extends dp_donors with a direct GHL contact id discovered via the
-- DonorPerfect → GHL enrichment script. Without this, only donors who
-- match a family-graph parent get an "Open in GHL" link — but most
-- donors (alumni, community, businesses) exist in GHL as contacts even
-- if they're not parents of a current student. The enrichment script
-- searches GHL by email and writes the contact id here so the directory
-- link goes straight to the contact instead of GHL's search page.

ALTER TABLE dp_donors
  ADD COLUMN IF NOT EXISTS ghl_contact_id text,
  ADD COLUMN IF NOT EXISTS ghl_contact_lookup_at timestamptz,
  ADD COLUMN IF NOT EXISTS ghl_contact_lookup_result text;

CREATE INDEX IF NOT EXISTS idx_dp_donors_ghl_contact
  ON dp_donors (school_id, ghl_contact_id)
  WHERE ghl_contact_id IS NOT NULL;
