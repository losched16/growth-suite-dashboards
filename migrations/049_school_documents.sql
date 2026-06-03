-- school_documents: school-uploaded resource files (supply lists,
-- calendars, parent handbook, etc.) surfaced to every family in the
-- parent portal under /resources. Different from
-- portal_form_submission_files (which is parent-uploaded responses to
-- form prompts) — this is operator-uploaded reference content.
--
-- Stored as bytea in-row, same pattern as form submission files.
-- Schools rarely have more than a few dozen of these at a time and
-- they're small (PDFs, calendars, slide decks); the convenience of
-- "one query, one delivery URL, no S3 lifecycle to manage" wins over
-- external storage for this dataset. If a school ever exceeds tens of
-- MB total here, switch to S3 — schema migration is straightforward.

CREATE TABLE IF NOT EXISTS school_documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id       uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,

  -- Display copy. title is what shows on the portal card; description is
  -- optional 1-2 line sub-label below it.
  title           text NOT NULL,
  description     text NULL,

  -- Grouping label for the portal page. Free-form so schools can name
  -- their own buckets (e.g. "Forms", "2026 Calendar", "Field Trip
  -- Permission Templates"). NULL falls into "Other" on the portal.
  category        text NULL,

  -- File payload. mime_type drives the download Content-Type header;
  -- original_filename drives Content-Disposition.
  original_filename text NOT NULL,
  mime_type         text NOT NULL,
  size_bytes        integer NOT NULL CHECK (size_bytes >= 0),
  contents          bytea NOT NULL,

  -- Ordering inside a category. Lower = first. Ties break by title.
  position        integer NOT NULL DEFAULT 0,

  -- Soft-delete so historical references don't 404. The dashboard
  -- "delete" action sets is_active=false; the portal hides inactive
  -- rows but the file stays in the DB for audit / undelete.
  is_active       boolean NOT NULL DEFAULT true,

  -- Audit
  uploaded_by_email text NULL,
  uploaded_at     timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_school_documents_school_active_pos
  ON school_documents (school_id, is_active, category, position, title);

COMMENT ON TABLE school_documents IS
  'Operator-uploaded reference docs surfaced to parents under /resources. Distinct from portal_form_submission_files (parent-uploaded form responses).';
