-- 079: official-PDF form templates ("DocuSign-style" fillable PDFs).
--
-- Some forms are unmodifiable official artifacts (state emergency cards,
-- diocese forms): the school uploads the PDF as-is, its AcroForm fields
-- are mapped to normal field_schema blocks (block.pdf_field = the PDF's
-- field name), parents fill the form in the portal like any other, and
-- on submit the answers are written onto the actual PDF (typed signature
-- + date stamped on the signature widget), flattened, and stored on the
-- student's record.
--
-- One template per form. Replacing the upload replaces the row.

CREATE TABLE IF NOT EXISTS portal_form_pdf_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  form_definition_id uuid NOT NULL UNIQUE
    REFERENCES portal_form_definitions(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  file_bytes bytea NOT NULL,
  page_count int,
  -- Raw AcroForm field inventory captured at upload (name/type/page),
  -- kept for the mapping UI + debugging odd state PDFs.
  field_inventory jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pfpt_school ON portal_form_pdf_templates (school_id);
