-- 057: FACTS transaction ledger + 'pending' enrollment status.
--
-- (1) facts_transactions: one row per student per academic year from
--     the school's FACTS billing export (charges by category, credits,
--     payments, remaining balance). Source of truth for "what FACTS
--     says this family owes" — kept separate from our invoices/
--     payments tables, which track Growth Suite-initiated billing.
--     unique_id can carry a "-1" style suffix when a split household
--     has two FACTS ledgers for the same student.
--
-- (2) enrollments.status gains 'pending' — DGM's registrar database
--     uses Pending for re-enrollments awaiting paperwork; the roster
--     status pill shows the value verbatim.

ALTER TABLE enrollments DROP CONSTRAINT IF EXISTS enrollments_status_check;
ALTER TABLE enrollments ADD CONSTRAINT enrollments_status_check CHECK (
  status = ANY (ARRAY[
    'inquiry'::text, 'tour_scheduled'::text, 'application_submitted'::text,
    'accepted'::text, 'enrolled'::text, 'waitlisted'::text,
    'withdrawn'::text, 'declined'::text, 'pending'::text
  ])
);

CREATE TABLE IF NOT EXISTS facts_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id uuid REFERENCES students(id) ON DELETE SET NULL,
  unique_id text NOT NULL,
  academic_year text NOT NULL,
  parent_name text,
  student_name text,
  -- per-category dollar amounts in cents, keyed by snake_case category
  charges jsonb NOT NULL DEFAULT '{}'::jsonb,
  credits jsonb NOT NULL DEFAULT '{}'::jsonb,
  total_charges_cents integer NOT NULL DEFAULT 0,
  total_credits_cents integer NOT NULL DEFAULT 0,
  net_charges_cents integer NOT NULL DEFAULT 0,
  payments_cents integer NOT NULL DEFAULT 0,
  credits_applied_cents integer NOT NULL DEFAULT 0,
  remaining_balance_cents integer NOT NULL DEFAULT 0,
  source_file text,
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, unique_id, academic_year)
);

CREATE INDEX IF NOT EXISTS idx_facts_tx_school_student
  ON facts_transactions (school_id, student_id);
