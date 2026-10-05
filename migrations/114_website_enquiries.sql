-- 114_website_enquiries.sql
--
-- Enquiries from the contact form on a school's PUBLIC MARKETING WEBSITE,
-- posted to /api/website/contact/{locationId}.
--
-- The row is written BEFORE the GoHighLevel push and is never rolled back if
-- that push fails. A parent who fills in a form and reads "thank you" must
-- never have their message disappear because a token expired or GHL was
-- having a bad afternoon; ghl_contact_id and ghl_error record how delivery
-- went, so a failed one can be found and replayed instead of being lost.
--
-- (FLMA's form previously called preventDefault() and showed the thank-you
-- card without sending anything at all. Every enquiry since launch went
-- nowhere. This table is the fix for that, not an optimisation.)

CREATE TABLE IF NOT EXISTS website_enquiries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id       uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,

  first_name      text NOT NULL,
  last_name       text,
  email           text NOT NULL,
  phone           text,
  -- Which programme the family picked, free text as the form offered it.
  program         text,
  message         text NOT NULL,
  -- Which button sent them here: 'contact', 'application', 'financial-aid'.
  intent          text NOT NULL DEFAULT 'contact',

  -- Delivery to GHL. Null id with a non-null error means it needs replaying.
  ghl_contact_id  text,
  ghl_error       text,

  -- Kept for rate limiting and for telling a bot run from a real one.
  source_origin   text,
  source_ip       text,
  user_agent      text,

  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_website_enquiries_school
  ON website_enquiries (school_id, created_at DESC);

-- The rate-limit lookup: how many from this address in the last few minutes.
CREATE INDEX IF NOT EXISTS idx_website_enquiries_ip
  ON website_enquiries (source_ip, created_at DESC);

-- Anything that still needs delivering.
CREATE INDEX IF NOT EXISTS idx_website_enquiries_undelivered
  ON website_enquiries (school_id, created_at DESC)
  WHERE ghl_contact_id IS NULL;

-- Which origin may POST that school's form. A write endpoint open to the
-- whole web is an invitation, and a hard-coded client domain does not belong
-- in a multi-tenant app, so the allowed origin lives with the school.
-- Comma-separated to cover a preview domain and a live one during cutover.
ALTER TABLE schools ADD COLUMN IF NOT EXISTS website_origin text;

COMMENT ON COLUMN schools.website_origin IS
  'Comma-separated scheme://host origins allowed to POST this school''s public website forms, e.g. "https://folsomlakemontessori.org,https://www.folsomlakemontessori.org".';
