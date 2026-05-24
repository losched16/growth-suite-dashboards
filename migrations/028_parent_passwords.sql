-- Parent password auth — replaces magic-link as the primary login.
--
-- Each parent gets a scrypt-hashed password stored on the parents row.
-- The /login page lets them set one on first use (no email required),
-- then sign in with it thereafter.
--
-- We keep the parent_magic_link_tokens table around for future use
-- but won't be issuing tokens from the demo flow.

ALTER TABLE parents
  ADD COLUMN IF NOT EXISTS password_hash text,
  ADD COLUMN IF NOT EXISTS password_set_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_parents_email_lower_active
  ON parents (LOWER(email))
  WHERE status = 'active' AND email IS NOT NULL;

COMMENT ON COLUMN parents.password_hash IS
  'Scrypt-hashed password (format salt:hex). Set by the parent on first /login. NULL means "no password set yet — first-time setup mode."';
