-- 113_website_documents.sql
--
-- Dated documents for a school's PUBLIC MARKETING WEBSITE: the monthly
-- classroom newsletters / lesson plans and the lunch menu that FLMA's
-- Parent Resources page lists as download cards. Managed from the school
-- dashboard at /school/{locationId}/website-documents and read by the
-- static site through the public API at /api/website/documents/{locationId}.
--
-- Deliberately NOT school_documents (migration 049). Those are parent-portal
-- documents for enrolled families; these go on the open web. Keeping the two
-- tables apart means a public feed can never accidentally select a handbook
-- or a roster that was only ever meant for logged-in parents. The cost is
-- one more upload screen; the alternative is one wrong WHERE clause away
-- from publishing private material.
--
-- Bytes live in bytea, the same pattern as school_documents (049) and
-- website_gallery_photos (094): this app has only DATABASE_URL, no object
-- storage client. A month of newsletters is four or five PDFs of a few
-- hundred KB, so the rows stay small.
--
-- School-agnostic: keyed by school_id, so every school we onboard gets the
-- same manager and the same website feed with no per-school code.

CREATE TABLE IF NOT EXISTS website_documents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id         uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,

  -- Which part of the website section this belongs to. Free text rather
  -- than an enum so a school can add a section without a migration; the
  -- website knows 'newsletter' and 'menu' and renders anything else under
  -- a generic heading.
  section           text NOT NULL DEFAULT 'newsletter',

  -- The card's heading on the site, e.g. "Maple Tree Classroom".
  label             text NOT NULL,

  -- The month the document is FOR, always stored as the first of that
  -- month. This is the whole point of the table: the site shows the newest
  -- month per section, so a school publishes next month's newsletters by
  -- uploading them with next month's date, and the page moves on by itself.
  -- Null means undated (shown last).
  period_month      date,

  original_filename text NOT NULL,
  mime_type         text NOT NULL DEFAULT 'application/pdf',
  size_bytes        integer NOT NULL DEFAULT 0,
  contents          bytea NOT NULL,

  position          integer NOT NULL DEFAULT 0,
  is_published      boolean NOT NULL DEFAULT true,
  uploaded_by_email text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- The feed's own access path: one school, published only, newest month first.
CREATE INDEX IF NOT EXISTS idx_website_documents_feed
  ON website_documents (school_id, section, period_month DESC, position);

-- Re-uploading the same classroom for the same month replaces it rather than
-- stacking a second card: the manager deletes the old row first, and this
-- keeps a double-submit from leaving two.
CREATE UNIQUE INDEX IF NOT EXISTS uq_website_documents_slot
  ON website_documents (school_id, section, period_month, lower(label))
  WHERE period_month IS NOT NULL;
