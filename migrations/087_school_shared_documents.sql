-- School-wide "important documents" pushed to the parent portal with the
-- same audience targeting the in-portal notifications use (program /
-- classroom / grade / tag / specific family, AND-OR combinable) PLUS an
-- exclude audience. Unlike student_documents (one file per student,
-- office-uploaded), a shared document is uploaded ONCE and every family
-- matching the audience sees it in their portal Documents section under
-- "From your school".
--
-- Targeting is resolved DYNAMICALLY at view time — a family tagged into
-- a program next month automatically sees that program's documents, and
-- deactivating a document hides it everywhere at once.

CREATE TABLE IF NOT EXISTS school_shared_documents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id         uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,

  title             text NOT NULL,
  description       text,
  category          text,                    -- 'handbook' / 'calendar' / 'forms' / 'other'

  file_name         text NOT NULL,
  mime_type         text NOT NULL,
  size_bytes        int NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  file_bytes        bytea NOT NULL,

  -- Who sees it. include_audience uses the notifications Audience shape
  -- ({ match: 'all'|'any', conditions: [{field, values}] }); NULL means
  -- everyone. exclude_audience carves families OUT and always wins.
  include_audience  jsonb,
  exclude_audience  jsonb,
  audience_label    text,                    -- human summary shown in lists

  is_active         boolean NOT NULL DEFAULT true,
  uploaded_by       text,
  uploaded_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_school_shared_docs
  ON school_shared_documents (school_id, is_active, uploaded_at DESC);

COMMENT ON TABLE school_shared_documents IS
  'Office-uploaded documents shown in the parent portal, targeted by the notifications-style audience rules (with excludes). Evaluated per family at view time.';
