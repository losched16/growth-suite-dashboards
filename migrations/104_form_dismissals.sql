-- Parent-side dismissal of banner forms (Clint 8/27: "if they don't
-- want to register for golf, just allow them to dismiss it").
-- A dismissal silences the form for the FAMILY in the portal home
-- "Parent Forms" banner and the reminder emails. The form itself stays
-- available in the Forms page, and office trackers are unaffected.
-- An office push (live enrollment_invite) always overrides a dismissal.
--
-- No FKs: consistent with the other lightweight config tables; a
-- dangling row after a form/family delete is harmless.

CREATE TABLE IF NOT EXISTS portal_form_dismissals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL,
  family_id uuid NOT NULL,
  parent_id uuid,
  form_definition_id uuid NOT NULL,
  dismissed_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS portal_form_dismissals_family_form
  ON portal_form_dismissals (family_id, form_definition_id);
