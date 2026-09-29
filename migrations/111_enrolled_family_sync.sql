-- Enrolled-family sync: additive creation of new families, new enrolled
-- siblings, and newly-entered co-parents for schools whose family graph is
-- frozen in attributes_only mode (settings.auto_create_enrolled_families).

-- Cache the opportunity card NAME. At card-per-student schools the card is
-- named for the child, which is how the sync tells which sibling a newly
-- "Enrolled" card belongs to.
ALTER TABLE ghl_opportunities ADD COLUMN IF NOT EXISTS name text;

-- Items the sync could not resolve on its own (bad source data, ambiguous
-- matches) and that need a person. One row per (school, item_key): each run
-- upserts what it still sees and resolves what it no longer sees; the alert
-- email goes out once per new item and again daily while it stays open.
CREATE TABLE IF NOT EXISTS sync_attention (
  school_id       uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  item_key        text NOT NULL,
  message         text NOT NULL,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_alerted_at timestamptz,
  resolved_at     timestamptz,
  PRIMARY KEY (school_id, item_key)
);

CREATE INDEX IF NOT EXISTS idx_sync_attention_open
  ON sync_attention (school_id) WHERE resolved_at IS NULL;
