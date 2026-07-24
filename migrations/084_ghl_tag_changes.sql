-- Audit trail for contact tag changes observed by the sync.
--
-- ghl_contact_tags is a full snapshot (delete + reinsert every cycle), so
-- "who removed the pending tag from this contact, and when?" was
-- unanswerable from our side — the office had to dig through the CRM's
-- per-contact activity log. The sync now diffs the old snapshot against
-- the new one before replacing it and records every add/removal here.
--
-- This logs WHAT changed and WHEN we first saw it (within one sync
-- interval); WHO made the change still lives in the CRM's activity log.

CREATE TABLE IF NOT EXISTS ghl_tag_changes (
  id              bigserial PRIMARY KEY,
  school_id       uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  ghl_contact_id  text NOT NULL,
  tag             text NOT NULL,
  change          text NOT NULL CHECK (change IN ('added', 'removed')),
  seen_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ghl_tag_changes_contact
  ON ghl_tag_changes (school_id, ghl_contact_id, seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_ghl_tag_changes_tag
  ON ghl_tag_changes (school_id, tag, seen_at DESC);

COMMENT ON TABLE ghl_tag_changes IS
  'Tag adds/removals observed between sync snapshots. Answers "when did this contact gain/lose tag X" — the CRM activity log still answers "who".';
