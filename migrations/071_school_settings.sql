-- 071: per-school settings bag — kills the hardcoded per-school lists in code.
--
-- schools.settings (jsonb) holds school-level behavior toggles that were
-- previously hardcoded school-id sets sprinkled across both repos:
--   academic_year        text     e.g. '2026-27' (was const CURRENT_YEAR)
--   portal_gate_stage    text     pipeline stage that unlocks parent portal
--                                 account creation (was PORTAL_PENDING_GATE_SCHOOLS
--                                 + PENDING_STAGE_NAME). null/absent = ungated.
--   auto_student_ids     boolean  auto-assign 8-digit Student IDs to students
--                                 missing one (was AUTO_STUDENT_ID_SCHOOLS)
--   promote_parent2      boolean  nightly Parent-2 → own-contact promotion
--                                 (was PROMOTE_PARENT2_SCHOOLS)
--   roster_tag_filter    text[]   only contacts carrying one of these tags become
--                                 roster families (was ROSTER_TAG_FILTER)
--
-- Everything is read with code defaults, so absent keys = previous default
-- behavior for schools that never opted in.

ALTER TABLE schools ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Backfill: current academic year for every school (matches the old global const).
UPDATE schools SET settings = settings || '{"academic_year":"2026-27"}'::jsonb;

-- DGM 2.0 — the behaviors it had via hardcoded lists.
UPDATE schools SET settings = settings || '{
  "portal_gate_stage": "Pending",
  "auto_student_ids": true,
  "promote_parent2": true
}'::jsonb
WHERE id = '005c2872-dd27-4c43-9b3c-5fd353b8db44';

-- Spruce Tree — roster tag filter.
UPDATE schools SET settings = settings || '{
  "roster_tag_filter": ["2026-27 stms", "withdrawn"]
}'::jsonb
WHERE id = '4aba0898-ec93-42ed-8e87-5374ca211738';
