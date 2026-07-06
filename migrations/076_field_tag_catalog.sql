-- Self-adapting data layer, Phase 1 — the living field & tag catalog.
--
-- On every sync we enumerate the location's GHL custom fields (with type +
-- options) and the tags in use, and diff them into these per-school catalogs.
-- This is what makes the platform "flexible forever": a field or tag a school
-- adds in GHL after day 1 is auto-discovered here and becomes available as a
-- dashboard column / filter / sort / form condition (Phase 2), with no support
-- ticket. Additions are always safe; only rename/delete of an in-use core
-- field is dangerous (handled separately by core-edit protection).
--
-- These tables are OUR read model of GHL's field/tag surface — GHL stays the
-- source of truth. Writing here is safe and non-destructive.

CREATE TABLE IF NOT EXISTS school_field_catalog (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id      uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,

  -- Normalized fieldKey (no "contact." prefix), e.g. student_1_grade_level.
  field_key      text NOT NULL,
  ghl_field_id   text NULL,          -- the GHL custom field id (for writes later)
  label          text NULL,          -- the field's display name in GHL
  data_type      text NULL,          -- TEXT | LARGE_TEXT | NUMERICAL | DATE | PHONE | MONETORY | SINGLE_OPTIONS | ...
  options        jsonb NOT NULL DEFAULT '[]'::jsonb,  -- picklist option labels (vocabulary is GHL-authoritative)

  -- Core = one of the ~150 field-kit fields the platform already depends on
  -- (protected). Discovered = a field the school added later (embraced).
  is_core        boolean NOT NULL DEFAULT false,
  -- The school has chosen to actually use this field (show it on a dashboard,
  -- etc.). Discovery makes a field AVAILABLE; surfacing is the school's choice.
  surfaced       boolean NOT NULL DEFAULT false,

  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  -- Set when a field that was present goes missing on a later sync (a possible
  -- core-edit break to alert on). NULL = currently present.
  missing_since  timestamptz NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (school_id, field_key)
);
CREATE INDEX IF NOT EXISTS idx_field_catalog_school ON school_field_catalog (school_id);

CREATE TABLE IF NOT EXISTS school_tag_catalog (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id      uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,

  tag            text NOT NULL,           -- normalized (lower/trimmed) tag
  -- Reserved tags ('parent 1', 'parent 2', 'withdrawn') that drive platform
  -- logic — flagged so they aren't offered as generic filters unaware.
  is_reserved    boolean NOT NULL DEFAULT false,
  surfaced       boolean NOT NULL DEFAULT false,
  contact_count  integer NOT NULL DEFAULT 0,  -- how many contacts carry it (usage signal)

  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),

  UNIQUE (school_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_tag_catalog_school ON school_tag_catalog (school_id);
