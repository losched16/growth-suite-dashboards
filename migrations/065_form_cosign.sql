-- 065_form_cosign.sql
-- DocuSign-style counter-signature for agreements that require a second
-- guardian. When the enrollment form's Legal Decision-Making Authority
-- answer is "joint", Parent 1 fills + signs, then Parent 2 is emailed a
-- secure link to review the completed agreement and add their signature.
-- The submission stays in a "submitted" status (Parent 1 is done) but is
-- not fully executed until cosign_status = 'signed'.
--
-- Tracked on the submission row (no separate table) — one co-signer per
-- submission, which matches the enrollment use-case.

ALTER TABLE portal_form_submissions
  ADD COLUMN IF NOT EXISTS cosign_status   text
    CHECK (cosign_status IN ('awaiting', 'signed', 'declined')),
  ADD COLUMN IF NOT EXISTS cosign_email     text,
  ADD COLUMN IF NOT EXISTS cosign_name      text,
  ADD COLUMN IF NOT EXISTS cosign_token     text,
  ADD COLUMN IF NOT EXISTS cosign_sent_at   timestamptz,
  ADD COLUMN IF NOT EXISTS cosign_signed_at timestamptz,
  ADD COLUMN IF NOT EXISTS cosign_signature text,
  ADD COLUMN IF NOT EXISTS cosign_ip        text;

-- The token is the bearer credential for the co-sign page, so it must be
-- unique. Partial index keeps NULLs (the vast majority of rows) out of it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pfs_cosign_token
  ON portal_form_submissions (cosign_token)
  WHERE cosign_token IS NOT NULL;
