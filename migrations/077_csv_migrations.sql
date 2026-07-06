-- 077_csv_migrations.sql
-- Self-serve CSV migration: a school uploads a legacy export (FACTS, TADS,
-- Brightwheel, a plain roster CSV), the engine proposes a column → GHL-field
-- mapping, the operator reviews/edits it, and (when enabled) applies it into
-- the school's GHL sub-account. Storing the parsed rows + mapping lets the
-- review and apply steps be separate requests. Rows can contain PII (parent
-- emails, student names) — same class of data we already sync — and cascade
-- away with the school.

CREATE TABLE IF NOT EXISTS csv_migrations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id       uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  filename        text,
  -- [{ name, sample_values[] }] — one per CSV column, in original order.
  columns         jsonb NOT NULL DEFAULT '[]'::jsonb,
  row_count       integer NOT NULL DEFAULT 0,
  -- ALL parsed rows as objects keyed by column name (capped at upload time).
  rows            jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- [{ csv_column, target_key, target_label, target_kind, target_type,
  --    ghl_field_id, confidence, method, skip }] — the reviewable mapping.
  mapping         jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- proposed → reviewed → applied
  status          text NOT NULL DEFAULT 'proposed',
  applied_at      timestamptz,
  applied_summary jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS csv_migrations_school_idx
  ON csv_migrations (school_id, created_at DESC);
