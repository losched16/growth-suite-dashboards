-- 050_kiosk_checkinout.sql
--
-- Unified check-in/out kiosk: parents AND pickup persons authenticate
-- with a personal PIN at /kiosk/<school> (parent portal, no login).
--
-- 1. parents get pin_hash/pin_set_at — each parent (including both
--    parents of divorced households, each from their own login) sets
--    their own PIN. Mirrors the columns pickup_persons already has.
--
-- 2. pin_lookup on both tables: HMAC-SHA256(secret, school_id:pin).
--    scrypt hashes can't be looked up directly (per-row salt), so
--    verifying a PIN against N candidates costs N scrypt ops — too
--    slow at full adoption. The deterministic lookup digest gives O(1)
--    candidate selection; the scrypt hash is still verified after the
--    lookup as defense-in-depth. Also powers the school-wide PIN
--    uniqueness check at set time (two people sharing a PIN would make
--    attribution ambiguous).
--
-- 3. attendance_events gains kiosk attribution: source ('kiosk' vs
--    NULL for portal / admin paths), performed_by_pickup_person_id
--    (grandma CHECKING IN — the existing picked_up_by_* columns only
--    attribute checkout), and performed_by_name_snapshot for stable
--    display in audit feeds even if the person row is later renamed.
--
-- 4. pickup_pin_attempts.parent_id — the shared rate-limit/audit table
--    now logs which parent matched, not just pickup persons.

BEGIN;

ALTER TABLE parents
  ADD COLUMN IF NOT EXISTS pin_hash text,
  ADD COLUMN IF NOT EXISTS pin_set_at timestamptz,
  ADD COLUMN IF NOT EXISTS pin_lookup text;

ALTER TABLE pickup_persons
  ADD COLUMN IF NOT EXISTS pin_lookup text;

CREATE INDEX IF NOT EXISTS parents_pin_lookup_idx
  ON parents(school_id, pin_lookup) WHERE pin_lookup IS NOT NULL;
CREATE INDEX IF NOT EXISTS pickup_persons_pin_lookup_idx
  ON pickup_persons(school_id, pin_lookup) WHERE pin_lookup IS NOT NULL;

ALTER TABLE attendance_events
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS performed_by_pickup_person_id uuid REFERENCES pickup_persons(id),
  ADD COLUMN IF NOT EXISTS performed_by_name_snapshot text;

ALTER TABLE pickup_pin_attempts
  ADD COLUMN IF NOT EXISTS parent_id uuid;

COMMENT ON COLUMN attendance_events.source IS
  'Where the event came from: kiosk | NULL (parent portal / admin). Drives the audit badge in staff feeds.';

COMMIT;
