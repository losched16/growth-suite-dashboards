-- 061: FACTS per-account ledger.
--
-- facts_transactions (057) holds ONE rolled-up row per student per year
-- (charges by category + aggregate credits / payments / balance). The CFO
-- needs the line-level detail behind the roster's "Payments" and "Credits
-- Applied" columns: for each student, exactly which FACTS account (Tuition,
-- Enrollment Fee, Administrative Fee, Extended Day, Lunch, Chromebook Fee,
-- Withdrawal Fee, ...) each charge / credit / payment landed on.
--
-- This table is that detail — one row per (student, academic year, FACTS
-- account), sourced from the school's per-account FACTS exports. The
-- rolled-up facts_transactions row is refreshed from the SUM of these
-- lines so the two always reconcile.
--
--   facts_student_id: the raw FACTS "Student ID" as it appears in the
--   export. Can differ from the matched Growth Suite student's unique_id
--   (FACTS and the SIS occasionally disagree) and can carry a "-1"/"-2"
--   suffix for a split household with two FACTS ledgers — so it is stored
--   verbatim and the GS student is linked separately via student_id.

CREATE TABLE IF NOT EXISTS facts_account_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id uuid REFERENCES students(id) ON DELETE SET NULL,
  facts_student_id text NOT NULL,
  academic_year text NOT NULL,
  student_name text,
  account text NOT NULL,               -- FACTS account display name (e.g. "Tuition")
  account_key text NOT NULL,           -- canonical snake_case key (e.g. "annual_tuition")
  beginning_balance_cents integer NOT NULL DEFAULT 0,
  charges_cents integer NOT NULL DEFAULT 0,
  credits_cents integer NOT NULL DEFAULT 0,   -- discounts/credits applied to this account
  payments_cents integer NOT NULL DEFAULT 0,  -- cash collected against this account
  ending_balance_cents integer NOT NULL DEFAULT 0,
  source_file text,
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, academic_year, facts_student_id, account_key)
);

CREATE INDEX IF NOT EXISTS idx_facts_ledger_school_student
  ON facts_account_ledger (school_id, student_id);
CREATE INDEX IF NOT EXISTS idx_facts_ledger_account
  ON facts_account_ledger (school_id, academic_year, account_key);
