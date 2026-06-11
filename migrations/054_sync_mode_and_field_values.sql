-- 054_sync_mode_and_field_values.sql
--
-- Two things:
--
-- 1. schools.sync_mode — per-school control over the 6-hour cron sync.
--    The cron's runGhlSync is SNAPSHOT semantics (delete + reinsert the
--    whole family graph from GHL). That's correct for schools whose
--    roster lives in GHL, but catastrophic for schools whose roster is
--    DB-managed via imports (DGM's 6-8 spreadsheet import created 42
--    students that don't exist in GHL — a snapshot sync would silently
--    delete them). Discovered: the cron currently FAILS for DGM/MCH on
--    an attendance_events FK violation, which is the only thing
--    protecting their rosters. This makes the protection explicit.
--
--      'snapshot'        → full destructive GHL → family-graph sync (default)
--      'attributes_only' → only the additive tags/fields/opportunities sync
--      'off'             → cron skips the school entirely
--
-- 2. ghl_contact_field_values — per-contact custom-field values, so ANY
--    GHL custom field is filterable even when it isn't mapped into
--    students.metadata. (The catalog stores labels + sample values; this
--    stores the actual per-contact values to filter against.)

BEGIN;

ALTER TABLE schools
  ADD COLUMN IF NOT EXISTS sync_mode text NOT NULL DEFAULT 'snapshot'
  CHECK (sync_mode IN ('snapshot', 'attributes_only', 'off'));

COMMENT ON COLUMN schools.sync_mode IS
  'Cron sync behavior: snapshot = destructive GHL family-graph rebuild; attributes_only = additive tags/fields/opportunities only (for import-managed rosters); off = skip.';

-- DGM + MCH rosters are DB-managed (spreadsheet/FACTS imports + portal
-- writes). Their family graphs must never be rebuilt from GHL.
UPDATE schools SET sync_mode = 'attributes_only'
 WHERE id IN ('cfa9030d-c8fe-49ae-a9e7-f1003844ec07',   -- Desert Garden Montessori
              'a6c4b2dd-050c-4bf9-893b-67106f0f20e8');  -- Media Children's House

CREATE TABLE IF NOT EXISTS ghl_contact_field_values (
  school_id      uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  ghl_contact_id text NOT NULL,
  field_key      text NOT NULL,            -- normalized fieldKey (contact. prefix stripped)
  value          text NOT NULL,
  synced_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (school_id, ghl_contact_id, field_key)
);
CREATE INDEX IF NOT EXISTS ghl_cfv_school_field_idx ON ghl_contact_field_values (school_id, field_key);

COMMENT ON TABLE ghl_contact_field_values IS
  'Synced per-contact GHL custom-field values (non-empty only). Additive sync. Lets dashboards filter on any GHL field via parents.ghl_contact_id.';

COMMIT;
