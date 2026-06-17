-- 062_immunizations.sql
--
-- NC immunization tracking for MCS (multi-tenant; scoped by school_id).
-- Three tables:
--   student_immunization_doses    — one row per recorded dose (the ledger)
--   student_immunization_profile  — per-student compliance flags
--   student_vaccine_flags         — per-student-per-vaccine flags
--
-- The schedule/requirements themselves live in lib/immunizations/
-- schedule.ts (reviewable data), NOT in the DB — these tables only store
-- what's true about a given child. Status (up-to-date / overdue / etc.)
-- is COMPUTED from these rows + the schedule, never stored stale.
--
-- Model note: vaccines are tracked by due-by-age, not "expiration."
-- Renewable DOCUMENTS (DCD medical report, TB test, immunization record
-- on file) keep using student_documents.expires_at.

BEGIN;

-- ── The dose ledger ───────────────────────────────────────────────────
-- One row per (student, vaccine, dose#). date_administered may be null
-- when a record says a dose is "Not Applicable" for this child (e.g. the
-- 4th Hib after the 5th birthday) — captured via status_override.
CREATE TABLE IF NOT EXISTS student_immunization_doses (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id         uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id        uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,

  vaccine_code      text NOT NULL,            -- matches VaccineCode in schedule.ts
  dose_number       int  NOT NULL CHECK (dose_number >= 1 AND dose_number <= 6),
  date_administered date,                      -- null allowed for na / unknown-but-received

  -- Optional manual override of the computed status for this one dose.
  -- 'not_applicable' | 'skipped' | null (let the engine compute).
  status_override   text CHECK (status_override IN ('not_applicable','skipped')),

  -- Where the data came from, for the audit trail.
  source            text NOT NULL DEFAULT 'office'
                      CHECK (source IN ('office','parent','import','transparent_classroom')),
  notes             text,

  created_by        text,                      -- operator email / 'parent:<id>'
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  UNIQUE (student_id, vaccine_code, dose_number)
);

CREATE INDEX IF NOT EXISTS idx_imm_doses_student ON student_immunization_doses (student_id);
CREATE INDEX IF NOT EXISTS idx_imm_doses_school  ON student_immunization_doses (school_id);

-- ── Per-student compliance profile ────────────────────────────────────
CREATE TABLE IF NOT EXISTS student_immunization_profile (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id           uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id          uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,

  -- Has the family submitted a certificate of immunization at all?
  -- Drives the report's "No Record" category when false.
  certificate_on_file boolean NOT NULL DEFAULT false,
  -- The uploaded record (image/PDF) kept on file. expires_at on that row
  -- handles the annual re-attest reminder.
  certificate_document_id uuid REFERENCES student_documents(id) ON DELETE SET NULL,

  -- Exemption that covers ALL vaccines (per-vaccine exemptions live on
  -- student_vaccine_flags). 'none' | 'medical' | 'religious'.
  all_vaccine_exemption text NOT NULL DEFAULT 'none'
                        CHECK (all_vaccine_exemption IN ('none','medical','religious')),

  -- "In process" = on a physician-approved catch-up schedule. NC counts
  -- these as compliant but still reports them under "Not Up to Date".
  in_process          boolean NOT NULL DEFAULT false,
  in_process_note     text,

  -- Override which NC report this student rolls into (else derived from
  -- program/grade + DOB). 'child_care'|'kindergarten'|'grade_7'|'grade_12'.
  report_context_override text
                        CHECK (report_context_override IN ('child_care','kindergarten','grade_7','grade_12')),

  notes               text,
  reviewed_by         text,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),

  UNIQUE (school_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_imm_profile_student ON student_immunization_profile (student_id);

-- ── Per-student-per-vaccine flags ─────────────────────────────────────
-- Captures vaccine-specific exemptions and documented immunity (titer /
-- history of disease counts as up-to-date for MMR & Varicella), plus a
-- manual "not required" override.
CREATE TABLE IF NOT EXISTS student_vaccine_flags (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id          uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id         uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  vaccine_code       text NOT NULL,

  exemption          text NOT NULL DEFAULT 'none'
                       CHECK (exemption IN ('none','medical','religious')),
  immunity_documented boolean NOT NULL DEFAULT false,  -- titer / history of disease
  not_required        boolean NOT NULL DEFAULT false,  -- manual na override
  note               text,
  updated_at         timestamptz NOT NULL DEFAULT now(),

  UNIQUE (student_id, vaccine_code)
);

CREATE INDEX IF NOT EXISTS idx_imm_flags_student ON student_vaccine_flags (student_id);

COMMIT;
