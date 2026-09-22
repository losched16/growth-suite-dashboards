-- Signature PNGs move out of attendance_events.
--
-- Every kiosk / portal check-in and pick-up stores the drawn signature as
-- a base64 data URL. Kept on attendance_events that column TOASTed to
-- 382 MB (DGM, 2026-09-22), and the sync's preserve/restore rebuild copies
-- the whole table out and back inside a transaction bound by the DB-wide
-- 2-minute statement timeout — the school stopped syncing (17 straight
-- failures). Signatures never need to move during a rebuild: event ids
-- are stable across it. So they live here, with NO foreign key to
-- attendance_events — the rebuild deletes and re-inserts events and this
-- table is simply untouched; the sync removes orphans (signatures whose
-- event was dropped with a vanished student) right after the restore.
-- Same data-URL format as the old column, so readers only change the
-- table they read from.
--
-- Rollout: (1) this table, (2) chunked backfill from the old column,
-- (3) deploy writers/readers, (4) second backfill pass for the gap,
-- (5) migration 109 drops the old column — that alone shrinks the
-- sync's copy from ~391 MB to ~12 MB (the dropped column's TOAST is no
-- longer read).
CREATE TABLE IF NOT EXISTS attendance_signatures (
  event_id   uuid PRIMARY KEY,
  school_id  uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  png        text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_attendance_signatures_school ON attendance_signatures (school_id);
