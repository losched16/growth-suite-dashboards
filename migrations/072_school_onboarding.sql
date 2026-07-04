-- School onboarding portal: tracks a school's SOFTWARE setup (NOT billing —
-- tuition/Stripe/invoicing are the partner's separate track). Three tables:
--   school_onboarding      — one row per prospective/active onboarding
--   onboarding_task_state  — state for non-derived tasks (document/manual/intake)
--   onboarding_documents   — school-uploaded intake files (bytea in-row)
--
-- Derived tasks (account created, roster imported, dashboards set up, etc.)
-- store NO state — they're computed live from real system tables. Only tasks
-- that carry submitted/approved/applied state get rows here.

CREATE TABLE IF NOT EXISTS school_onboarding (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Links to the tenant once provisioned (Phase 1 creates the schools row).
  -- NULL before that — a school onboards as a lead before it's a tenant.
  school_id        uuid NULL REFERENCES schools(id) ON DELETE SET NULL,

  -- Pre-tenant identity: the GHL contact/lead + (once known) the location.
  ghl_contact_id   text NULL,
  ghl_location_id  text NULL,

  school_name      text NOT NULL,
  contact_name     text NULL,
  contact_email    text NOT NULL,

  -- Denormalized from the live status derivation, kept fresh for GHL sync so
  -- reminder workflows can branch on it without querying our DB.
  stage            text NOT NULL DEFAULT 'invited',
  percent_complete integer NOT NULL DEFAULT 0 CHECK (percent_complete BETWEEN 0 AND 100),

  target_launch_date date NULL,
  assigned_ops_email text NULL,
  notes            text NULL,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_school_onboarding_school ON school_onboarding (school_id);
CREATE INDEX IF NOT EXISTS idx_school_onboarding_stage  ON school_onboarding (stage);

-- State for non-derived tasks: documents (via onboarding_documents too),
-- manual acknowledgements/sign-offs, and intake vocabularies. `payload` holds
-- intake values, e.g. { "values": ["Primary", "Lower Elementary"] }.
CREATE TABLE IF NOT EXISTS onboarding_task_state (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  onboarding_id    uuid NOT NULL REFERENCES school_onboarding(id) ON DELETE CASCADE,
  task_key         text NOT NULL,

  -- pending | submitted | approved | rejected | skipped | applied
  status           text NOT NULL DEFAULT 'pending',
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,

  submitted_at     timestamptz NULL,
  reviewed_by_email text NULL,
  review_note      text NULL,
  -- For intake tasks pushed into the GHL sub-account (picklist options).
  applied_to_ghl_at timestamptz NULL,
  applied_by_email  text NULL,

  updated_at       timestamptz NOT NULL DEFAULT now(),

  UNIQUE (onboarding_id, task_key)
);

CREATE INDEX IF NOT EXISTS idx_onboarding_task_state_onboarding
  ON onboarding_task_state (onboarding_id, task_key);

-- School-uploaded intake files (roster/import CSV, logo, handbook, etc.).
-- bytea in-row, same pattern as school_documents (migration 049). These are
-- SCHOOL -> US (intake), distinct from school_documents (US -> parents).
CREATE TABLE IF NOT EXISTS onboarding_documents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  onboarding_id    uuid NOT NULL REFERENCES school_onboarding(id) ON DELETE CASCADE,
  task_key         text NOT NULL,

  title            text NULL,
  original_filename text NOT NULL,
  mime_type        text NOT NULL,
  size_bytes       integer NOT NULL CHECK (size_bytes >= 0),
  contents         bytea NOT NULL,

  -- uploaded | accepted | rejected
  status           text NOT NULL DEFAULT 'uploaded',
  review_note      text NULL,
  reviewed_by_email text NULL,

  uploaded_by      text NULL,
  uploaded_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_onboarding_documents_onboarding
  ON onboarding_documents (onboarding_id, task_key, status);
