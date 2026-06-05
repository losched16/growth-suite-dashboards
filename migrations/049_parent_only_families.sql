-- 049_parent_only_families.sql
--
-- Add a per-school config flag that lets the GHL → DB sync keep
-- families that have ZERO students attached. Default OFF so every
-- existing school keeps current behavior (inquiry-pipeline families
-- with no student records are skipped).
--
-- Schools that import a roster of parents-only (no student data
-- yet) can flip this on so the sync's "snapshot-then-rebuild" pass
-- doesn't blow away their family graph every cron cycle.

BEGIN;

ALTER TABLE school_field_schemas
  ADD COLUMN IF NOT EXISTS allow_parent_only_families BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN school_field_schemas.allow_parent_only_families IS
  'When true, GHL sync keeps families with zero student rows. Use for schools whose GHL is parent-only until they backfill student data.';

COMMIT;
