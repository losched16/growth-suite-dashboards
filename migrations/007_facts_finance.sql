-- Holds the imported FACTS Management financial data per school. Source
-- of truth for "actual cash" figures the FinanceDashboard widget shows:
-- charges, payments, A/R, delinquent balances.
--
-- Import flow: operator drops the 3 FACTS exports (Customer / Student /
-- Balances) into the admin UI; the import script matches each balance
-- row to our family-graph student by name + customer name and writes
-- here. Re-running is idempotent — facts_balances key is
-- (school_id, term, facts_student_id) but the matched_student_id is
-- recomputed on each import.

CREATE TABLE IF NOT EXISTS facts_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  facts_customer_number text,        -- FACTS Customer Number (long numeric)
  facts_customer_id text,            -- shorter internal id where present
  first_name text,
  last_name text,
  emails text,                       -- newline-separated list as exported
  state text,
  status text,
  online_code text,
  -- Match to our family-graph: which family this FACTS customer represents.
  matched_family_id uuid REFERENCES families(id) ON DELETE SET NULL,
  match_method text,                 -- 'by_name' / 'by_email' / 'unmatched'
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, facts_customer_number)
);

CREATE INDEX IF NOT EXISTS idx_facts_customers_school ON facts_customers (school_id);
CREATE INDEX IF NOT EXISTS idx_facts_customers_family ON facts_customers (matched_family_id);

CREATE TABLE IF NOT EXISTS facts_students (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  facts_student_id text NOT NULL,
  first_name text,
  last_name text,
  customer_name text,                -- "Last, First" of the customer/parent
  grade text,
  status text,
  matched_student_id uuid REFERENCES students(id) ON DELETE SET NULL,
  match_method text,
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, facts_student_id)
);

CREATE INDEX IF NOT EXISTS idx_facts_students_school ON facts_students (school_id);
CREATE INDEX IF NOT EXISTS idx_facts_students_match ON facts_students (matched_student_id);

CREATE TABLE IF NOT EXISTS facts_balances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  term text NOT NULL,                -- e.g. '2025-2026 School Year'
  facts_customer_number text,
  customer_name text,
  facts_student_name text,           -- "Last, First" as exported
  grade text,
  charges numeric(12, 2) DEFAULT 0,
  credits numeric(12, 2) DEFAULT 0,
  payments numeric(12, 2) DEFAULT 0,
  remaining_amount_due numeric(12, 2) DEFAULT 0,
  remaining_credit_balance numeric(12, 2) DEFAULT 0,
  delinquent_balance numeric(12, 2) DEFAULT 0,
  -- Family-graph FKs (best-effort match; null if name didn't resolve)
  matched_student_id uuid REFERENCES students(id) ON DELETE SET NULL,
  matched_family_id uuid REFERENCES families(id) ON DELETE SET NULL,
  matched_customer_id uuid REFERENCES facts_customers(id) ON DELETE SET NULL,
  match_method text,
  imported_at timestamptz NOT NULL DEFAULT now()
);

-- One balance row per (school, term, customer, student) name combo.
-- We use customer+student name as the natural key because FACTS Student
-- IDs may not be in the Balances export (the Student List has them but
-- the Balances Report does not show them per row).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_facts_balances
  ON facts_balances (school_id, term, customer_name, facts_student_name);

CREATE INDEX IF NOT EXISTS idx_facts_balances_school_term
  ON facts_balances (school_id, term);

CREATE INDEX IF NOT EXISTS idx_facts_balances_unmatched
  ON facts_balances (school_id) WHERE matched_student_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_facts_balances_student
  ON facts_balances (matched_student_id) WHERE matched_student_id IS NOT NULL;
