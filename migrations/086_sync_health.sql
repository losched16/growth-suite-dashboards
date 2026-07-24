-- Per-school sync health, tracked by the sync-all cron. Exists so a
-- failing school ALERTS someone instead of silently going stale — DGM
-- ran 24 hours dark (first curbside check-in broke the rebuild) and
-- nobody knew until a new family was missing from the portal.

CREATE TABLE IF NOT EXISTS sync_health (
  school_id            uuid PRIMARY KEY REFERENCES schools(id) ON DELETE CASCADE,
  consecutive_failures int NOT NULL DEFAULT 0,
  last_error           text,
  last_ok_at           timestamptz,
  last_failure_at      timestamptz,
  last_alerted_at      timestamptz
);

COMMENT ON TABLE sync_health IS
  'Consecutive sync failures per school; the sync-all cron emails the operator at 3 in a row (>=15 min stale) and again on recovery.';
