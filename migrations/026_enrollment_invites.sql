-- Enrollment invites — operator-initiated form-fill flow.
--
-- Use case: Leslie (admissions coordinator) sets up an Enrollment
-- Agreement for the Johnson Family's incoming child. She picks the
-- family + student, enters the child's start date + grade level, and
-- the system emails the parent a one-time link. The parent clicks it
-- and lands on the enrollment form with those values already filled.
--
-- The token (random + non-guessable) sits in the URL; it bootstraps
-- the parent's session into a draft fill of the form.

CREATE TABLE IF NOT EXISTS enrollment_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  form_definition_id uuid NOT NULL REFERENCES portal_form_definitions(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  student_id uuid REFERENCES students(id) ON DELETE SET NULL,

  -- The unguessable token that goes in the URL (?invite=...).
  token text NOT NULL UNIQUE,

  -- Pre-filled values the operator entered. The renderer reads these
  -- and seeds the corresponding form fields. Shape: { field_key: value }.
  -- e.g. { "enrollment_start_date": "2026-08-26", "grade_level": "primary" }
  prefill jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Optional operator note (e.g. "starting late, prorated tuition").
  internal_note text,

  -- Lifecycle.
  -- created_at: when Leslie generated the invite
  -- sent_at:    when the email was successfully dispatched (NULL if she
  --             chose "copy link instead" or email failed)
  -- consumed_at: when the parent first submitted the form via this invite
  -- expires_at:  default = created_at + 30 days
  created_by_email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  consumed_at timestamptz,
  consumed_submission_id uuid REFERENCES portal_form_submissions(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days')
);

CREATE INDEX IF NOT EXISTS idx_enrollment_invites_token
  ON enrollment_invites (token) WHERE consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_enrollment_invites_school_form
  ON enrollment_invites (school_id, form_definition_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_enrollment_invites_family
  ON enrollment_invites (family_id, created_at DESC);

COMMENT ON TABLE enrollment_invites IS
  'Operator-generated one-time invites that pre-fill specific fields on a portal form. Parent clicks the email link, lands on /forms-v2/<slug>?invite=<token>, sees the form with operator-filled values, completes + submits.';
