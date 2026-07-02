-- Track when a parent OPENS a form in the portal (distinct from submitting).
-- Lets the forms tracking hub show, for families that haven't submitted yet,
-- whether they at least logged in and viewed the form — so the office knows
-- whether to resend a login invite vs. just nudge someone who already saw it.
--
-- One row per (school, parent, form); last_viewed_at + view_count updated on
-- each open. Aggregated by family in the hub. Views only accrue from the day
-- this ships forward (no historical backfill possible).

CREATE TABLE IF NOT EXISTS portal_form_views (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id          uuid NOT NULL,
  parent_id          uuid NOT NULL,
  family_id          uuid,
  form_definition_id uuid NOT NULL,
  first_viewed_at    timestamptz NOT NULL DEFAULT now(),
  last_viewed_at     timestamptz NOT NULL DEFAULT now(),
  view_count         integer NOT NULL DEFAULT 1,
  UNIQUE (school_id, parent_id, form_definition_id)
);

CREATE INDEX IF NOT EXISTS portal_form_views_form_idx
  ON portal_form_views (school_id, form_definition_id);
CREATE INDEX IF NOT EXISTS portal_form_views_family_idx
  ON portal_form_views (school_id, family_id);
