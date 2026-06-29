-- 066_form_list_in_checklist.sql
-- Some parent forms are "on-demand": accessible by direct link but NOT part
-- of the completion checklist (e.g. an Enrollment Amendment a parent only
-- fills if they need to change a prior selection). Without this they'd show
-- as a perpetual "Pending" item for every family. Default true preserves
-- today's behavior for all existing forms.

ALTER TABLE portal_form_definitions
  ADD COLUMN IF NOT EXISTS list_in_checklist boolean NOT NULL DEFAULT true;
