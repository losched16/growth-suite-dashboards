-- 097: per-form CRM tags applied on submission (Clint, Aug 10: "a list
-- of families that signed up for Flag Football so that I can send them
-- emails... a way for the school to do this at any time").
--
-- The school sets tags on a form (builder → Settings → "CRM tags on
-- submit"); every family that submits gets the tag(s) written to all
-- their parent contacts in the CRM. The office then emails the group
-- any time via a tag smart list — no exports, no asking us.
-- Setting/changing the tags also backfills existing submitters (the
-- dashboards form PATCH route does the backfill in after()).

ALTER TABLE portal_form_definitions
  ADD COLUMN IF NOT EXISTS submit_tags text[] NOT NULL DEFAULT '{}';
