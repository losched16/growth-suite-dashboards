-- Multi-use magic-link tokens for operator-initiated impersonation
-- (Family Hub "View as parent" + emailed spot-check links).
--
-- Parent self-login links stay single-use (multi_use=false, default) and
-- are consumed atomically on first use. Operator view/spot-check tokens
-- set multi_use=true so they're reusable within their TTL — email link
-- scanners (which GET every URL) and repeat clicks no longer burn them.
ALTER TABLE parent_magic_link_tokens
  ADD COLUMN IF NOT EXISTS multi_use boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN parent_magic_link_tokens.multi_use IS
  'true = reusable within TTL (operator view-as-parent / spot-check). false (default) = single-use parent self-login, consumed on first use.';
