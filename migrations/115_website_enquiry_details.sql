-- 115_website_enquiry_details.sql
--
-- Structured extras for website enquiries that are not plain messages, such
-- as an open house RSVP (which event, how many are coming, the children's
-- ages). Kept as jsonb on the same row rather than a table per form type:
-- every website form shares one path into GHL and one place to replay from.

ALTER TABLE website_enquiries ADD COLUMN IF NOT EXISTS details jsonb;

-- The message is optional on an RSVP, so it can no longer be required.
ALTER TABLE website_enquiries ALTER COLUMN message DROP NOT NULL;

-- Head-count per open house, for the office's planning.
CREATE INDEX IF NOT EXISTS idx_website_enquiries_event
  ON website_enquiries (school_id, (details->>'event'))
  WHERE intent = 'open-house';
