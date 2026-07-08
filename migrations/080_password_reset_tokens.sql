-- 080: parent password-reset tokens (self-serve "Forgot password?").
-- Single-use, 60-minute TTL, host-school-scoped at issue time. Same
-- plaintext-token pattern as parent_magic_link_tokens.
CREATE TABLE IF NOT EXISTS parent_password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL UNIQUE,
  parent_id uuid NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  email text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  request_ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pprt_parent ON parent_password_reset_tokens (parent_id);
