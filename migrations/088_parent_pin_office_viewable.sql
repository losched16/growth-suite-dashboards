-- 088: Office-viewable copy of the kiosk check-in PIN.
--
-- The portal keeps hashing PINs for verification (pin_hash/pin_lookup), but
-- also stores an AES-256-GCM-encrypted copy (ENCRYPTION_KEY) when a parent
-- sets or changes their PIN, so office staff can read the PIN back to a
-- parent from the Student Roster family panel. PINs set before this upgrade
-- have no encrypted copy and show as "set (not viewable)" until re-set.
--
-- NOTE: already applied directly to production on 2026-07-30; this file
-- formalizes the change for fresh environments.

ALTER TABLE parents ADD COLUMN IF NOT EXISTS pin_encrypted bytea;
ALTER TABLE parents ADD COLUMN IF NOT EXISTS pin_iv bytea;
ALTER TABLE parents ADD COLUMN IF NOT EXISTS pin_tag bytea;
