-- 056_school_staff_logins.sql
--
-- Standalone (non-GHL) staff access. Today school admins only get a
-- session via the GHL-embed JWT exchange; Canadian/standalone schools
-- have no GHL, so staff sign in with an emailed magic link instead —
-- same pattern as the parent portal's parent_magic_link_tokens, and it
-- mints the SAME gsd_school_session cookie the rest of /school uses.

BEGIN;

CREATE TABLE IF NOT EXISTS school_staff (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id  uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  email      text NOT NULL,
  name       text,
  role       text NOT NULL DEFAULT 'admin',     -- admin | staff (display only for now)
  status     text NOT NULL DEFAULT 'active',    -- active | inactive
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS school_staff_school_email_idx
  ON school_staff (school_id, lower(email));

CREATE TABLE IF NOT EXISTS staff_login_tokens (
  token      text PRIMARY KEY,                  -- random base64url, single use
  staff_id   uuid NOT NULL REFERENCES school_staff(id) ON DELETE CASCADE,
  school_id  uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  email      text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  request_ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_login_tokens_email_idx ON staff_login_tokens (lower(email), created_at);

COMMENT ON TABLE school_staff IS 'School staff allowed to sign in to the dashboards directly (magic link) — the non-GHL auth path for standalone schools.';

COMMIT;
