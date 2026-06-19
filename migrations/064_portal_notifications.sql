-- In-portal notifications: school admin → parents, audience-targeted.
--
-- Two tables:
--   portal_notifications            — one row per sent notification (the
--                                     message + a snapshot of who it targeted)
--   portal_notification_recipients  — one row per parent it was delivered to,
--                                     resolved at SEND time (audience frozen),
--                                     with per-parent read/dismiss state.
--
-- Audience (jsonb) is a combinable condition set:
--   { "match": "all" | "any",
--     "conditions": [
--       { "field": "all" }                              -- everyone (enrolled)
--       { "field": "program",     "values": [...] }      -- any kid in program
--       { "field": "homeroom",    "values": [...] }      -- any kid in classroom
--       { "field": "grade_level", "values": [...] }      -- any kid in grade
--       { "field": "tag",         "values": [...] }      -- parent has GHL tag
--       { "field": "family",      "values": [uuid,...] } -- specific families
--       { "field": "parent",      "values": [uuid,...] } -- specific parents
--     ] }
-- Single-condition = the quick picker; multiple = the power filter builder.
-- Resolution always restricts to ACTIVE parents of ENROLLED families (a
-- portal notification can only reach someone with a portal account).

CREATE TABLE IF NOT EXISTS portal_notifications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL,
  title            text NOT NULL,
  body             text NOT NULL,
  link_url         text,
  link_label       text,
  pinned           boolean NOT NULL DEFAULT false,
  audience         jsonb NOT NULL DEFAULT '{}'::jsonb,
  audience_label   text,
  recipient_count  integer NOT NULL DEFAULT 0,
  created_by_email text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_portal_notifications_school
  ON portal_notifications (school_id, created_at DESC);

CREATE TABLE IF NOT EXISTS portal_notification_recipients (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL REFERENCES portal_notifications(id) ON DELETE CASCADE,
  school_id       uuid NOT NULL,
  parent_id       uuid NOT NULL,
  family_id       uuid,
  read_at         timestamptz,
  dismissed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (notification_id, parent_id)
);
-- Unread-count + inbox lookups are per (school, parent).
CREATE INDEX IF NOT EXISTS idx_pnr_parent
  ON portal_notification_recipients (school_id, parent_id, read_at);
CREATE INDEX IF NOT EXISTS idx_pnr_notification
  ON portal_notification_recipients (notification_id);
