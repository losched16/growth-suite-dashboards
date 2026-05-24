-- 003_dashboards.sql
-- Additive migration on top of importer's 001 and family graph's 002.

-- Per-school dashboard configurations.
CREATE TABLE school_dashboards (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id       UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  dashboard_slug  TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  description     TEXT,
  layout          JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_enabled      BOOLEAN NOT NULL DEFAULT true,
  position        INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, dashboard_slug)
);

CREATE INDEX idx_school_dashboards_school ON school_dashboards(school_id);
CREATE INDEX idx_school_dashboards_enabled ON school_dashboards(school_id, is_enabled);

-- Optional audit log of widget data fetches (for slow-query / GHL-API debugging).
CREATE TABLE widget_fetch_log (
  id              BIGSERIAL PRIMARY KEY,
  school_id       UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  dashboard_slug  TEXT,
  widget_id       TEXT NOT NULL,
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_ms     INTEGER,
  cache_hit       BOOLEAN NOT NULL DEFAULT false,
  error           TEXT
);

CREATE INDEX idx_widget_fetch_log_school_time ON widget_fetch_log(school_id, fetched_at DESC);
