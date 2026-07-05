-- Maps each onboarding task to its help content — WITHOUT duplicating the
-- content. Freshdesk (or any KB) stays the single source of truth; we just
-- store the article URL + an optional short video per task. Global (keyed by
-- task_key, not per-school): the SOP for "connect your calendar" is the same
-- for every school. Editable by ops from /admin/onboarding/guides — no deploy.

CREATE TABLE IF NOT EXISTS onboarding_guides (
  task_key         text PRIMARY KEY,
  guide_url        text NULL,   -- e.g. a Freshdesk article URL
  guide_label      text NULL,   -- optional custom link label ("Read the guide")
  video_url        text NULL,   -- optional Loom / YouTube walkthrough
  updated_by_email text NULL,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
