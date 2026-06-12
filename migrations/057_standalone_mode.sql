-- 057_standalone_mode.sql
--
-- Standalone (non-GHL) school support:
--
-- require_staff_login — when true, the full-shell /school/[locationId]
-- pages demand a valid school session (staff magic-link or GHL embed)
-- and bounce anonymous visitors to /staff. Default FALSE so existing
-- schools' open dashboard URLs keep working exactly as today; flipped
-- on per standalone school.
--
-- (Currency uses the existing school_payment_config.default_currency
-- column — no schema change needed, just code that honors it.)

BEGIN;

ALTER TABLE schools
  ADD COLUMN IF NOT EXISTS require_staff_login boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN schools.require_staff_login IS
  'Standalone schools: gate /school/* full-shell pages behind a school session (staff magic-link). false = legacy open-URL behavior.';

COMMIT;
