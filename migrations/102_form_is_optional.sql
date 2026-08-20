-- 102: optional forms (Sonia Q19 + "yellow box shows forms as necessary
-- when they are not"). An optional form stays fully usable — listed in
-- the parents' Forms hub (marked "Optional"), submittable, trackable by
-- the office — but it never appears in the portal home's Action Items
-- banner, never counts against the family's completion %, and never
-- triggers reminder emails.

ALTER TABLE portal_form_definitions
  ADD COLUMN IF NOT EXISTS is_optional boolean NOT NULL DEFAULT false;
