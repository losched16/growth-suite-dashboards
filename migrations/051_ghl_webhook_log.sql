-- GHL webhook event log. Every inbound webhook from HighLevel
-- (Contact Updated, Contact Created, etc.) gets a row, regardless of
-- whether we successfully applied it. Used to:
--   1) Debug missed / malformed webhooks ("why didn't the Skulski
--      change land?")
--   2) Audit who/when changed what — paired with the existing
--      widget_fetch_log entries from the daily cron.
--   3) Detect outages: gaps + status=failed clusters tell us when
--      the integration broke.

CREATE TABLE IF NOT EXISTS ghl_webhook_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Resolved school (NULL when the locationId in the payload doesn't
  -- match any of our schools — typically a stale install or wrong env).
  school_id     uuid NULL REFERENCES schools(id) ON DELETE CASCADE,

  -- What GHL told us — preserved as-is for forensics
  event_type    text NOT NULL,                   -- 'ContactUpdate', 'ContactCreate', etc.
  ghl_location_id text NULL,                     -- from payload
  ghl_contact_id  text NULL,                     -- from payload
  payload       jsonb NOT NULL,                  -- full body (signature already verified)

  -- What we did
  status        text NOT NULL,                   -- 'applied' | 'ignored' | 'failed'
  rows_affected integer NOT NULL DEFAULT 0,      -- across parents + students
  error_message text NULL,

  -- Idempotency: GHL retries on 5xx. webhook_id is a per-event
  -- identifier they provide; we reject duplicates so a retry storm
  -- doesn't double-apply.
  webhook_id    text NULL,

  received_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ghl_webhook_log_school_received
  ON ghl_webhook_log (school_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_ghl_webhook_log_status_received
  ON ghl_webhook_log (status, received_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uidx_ghl_webhook_log_webhook_id
  ON ghl_webhook_log (webhook_id) WHERE webhook_id IS NOT NULL;

COMMENT ON TABLE ghl_webhook_log IS
  'One row per inbound GHL webhook. Used to audit + debug the contact-update sync. school_id NULL = location not recognized; status=ignored = nothing matched our DB (parent contact id unknown).';
