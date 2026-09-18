-- Contact-level mirror + pipeline stage-change log, for admissions analytics.
--
-- The attribute sync already mirrors tags / custom-field values /
-- opportunities, but not the contact record itself — so "when did this
-- family first reach us?" (GHL dateAdded), "through which channel?"
-- (source) and "who is this?" (name/email, to group a family's split
-- contacts) were unanswerable from our side. ghl_contacts is a full
-- snapshot, refreshed every attribute sync (additive layer only — never
-- read by the family-graph sync).
--
-- ghl_opportunities is also a snapshot (current stage only). The sync now
-- diffs old vs new before replacing it and logs every stage move here, so
-- time-in-stage can be measured going forward. stage_changed_at is GHL's
-- lastStageChangeAt when present (precise); seen_at is when we noticed.

CREATE TABLE IF NOT EXISTS ghl_contacts (
  school_id      uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  ghl_contact_id text NOT NULL,
  first_name     text,
  last_name      text,
  email          text,
  phone          text,
  source         text,
  contact_type   text,
  date_added     timestamptz,
  date_updated   timestamptz,
  synced_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (school_id, ghl_contact_id)
);

CREATE TABLE IF NOT EXISTS ghl_opportunity_stage_changes (
  id               bigserial PRIMARY KEY,
  school_id        uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  opportunity_id   text NOT NULL,
  ghl_contact_id   text,
  pipeline_name    text,
  from_stage       text,          -- NULL = opportunity first seen
  to_stage         text,
  stage_changed_at timestamptz,
  seen_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ghl_opp_stage_changes_contact
  ON ghl_opportunity_stage_changes (school_id, ghl_contact_id, seen_at);
