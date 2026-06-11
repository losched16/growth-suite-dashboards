-- 053_ghl_attributes_catalog.sql
--
-- Foundation for self-serve filters. We capture EVERY GHL contact's
-- tags + opportunities into queryable tables, and build a per-school
-- "filter catalog" of every filterable attribute (tag, custom field,
-- pipeline stage). The dashboards then offer these as pick-and-choose
-- filters/columns, with GHL remaining the source of truth.
--
-- These tables are populated by an ADDITIVE sync (sync-ghl-attributes)
-- that never touches families/students/parents/enrollments — so a
-- school whose roster was loaded another way (e.g. a spreadsheet import)
-- keeps its roster while still gaining tag/opportunity filtering.

BEGIN;

-- ── Per-contact tags ────────────────────────────────────────────────
-- One row per (contact, tag). Filter a student by tag via
-- student → family → parents.ghl_contact_id → ghl_contact_tags.
CREATE TABLE IF NOT EXISTS ghl_contact_tags (
  school_id      uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  ghl_contact_id text NOT NULL,
  tag            text NOT NULL,
  synced_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (school_id, ghl_contact_id, tag)
);
CREATE INDEX IF NOT EXISTS ghl_contact_tags_school_tag_idx ON ghl_contact_tags (school_id, lower(tag));
CREATE INDEX IF NOT EXISTS ghl_contact_tags_contact_idx    ON ghl_contact_tags (ghl_contact_id);

-- ── Per-contact opportunities ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS ghl_opportunities (
  id                   text PRIMARY KEY,            -- GHL opportunity id
  school_id            uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  ghl_contact_id       text,
  pipeline_id          text,
  pipeline_name        text,
  stage_id             text,
  stage_name           text,
  status               text,                        -- open / won / lost / abandoned
  monetary_value       numeric,
  last_stage_change_at timestamptz,
  synced_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ghl_opportunities_school_contact_idx ON ghl_opportunities (school_id, ghl_contact_id);
CREATE INDEX IF NOT EXISTS ghl_opportunities_school_stage_idx   ON ghl_opportunities (school_id, pipeline_id, stage_name);

-- ── Per-school filter catalog ───────────────────────────────────────
-- Every attribute the school CAN filter/display, discovered from their
-- live GHL data. attr_key is the stable handle the dashboards use;
-- attr_type tells the UI how to render it.
--
--   attr_type:
--     'tag'                 → attr_key 'tag:<value>' OR a single 'tag' multi
--     'custom_field'        → attr_key 'cf:<base_field_key>'
--     'opportunity_stage'   → attr_key 'opp_stage'
--     'opportunity_status'  → attr_key 'opp_status'
--     'pipeline'            → attr_key 'pipeline'
CREATE TABLE IF NOT EXISTS school_filter_catalog (
  school_id      uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  attr_key       text NOT NULL,
  attr_type      text NOT NULL,
  label          text NOT NULL,
  ghl_field_id   text,                  -- for custom fields
  data_type      text,                  -- 'text' | 'number' | 'date' | 'select' | 'multi'
  sample_values  jsonb NOT NULL DEFAULT '[]'::jsonb,   -- distinct values seen (capped)
  value_count    integer NOT NULL DEFAULT 0,           -- # contacts with a non-empty value
  synced_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (school_id, attr_key)
);
CREATE INDEX IF NOT EXISTS school_filter_catalog_school_type_idx ON school_filter_catalog (school_id, attr_type);

COMMENT ON TABLE ghl_contact_tags IS 'Synced GHL contact tags. Additive — populated by sync-ghl-attributes, never by the destructive family-graph sync.';
COMMENT ON TABLE school_filter_catalog IS 'Per-school catalog of filterable/displayable attributes discovered from live GHL data (tags, custom fields, pipeline stages). Drives the self-serve filter picker.';

COMMIT;
