-- 083: per-school portal nav label overrides.
--
-- school_branding.portal_nav_labels (jsonb, href -> label) lets a school
-- rename portal menu items without code changes — pairs with the existing
-- portal_hidden_nav visibility toggles. DGM's first use: 'Important
-- Documents' -> 'School Documents' and 'Documents' -> 'Parent Documents'.
-- NULL / missing key = the default label in the portal layout.

ALTER TABLE school_branding
  ADD COLUMN IF NOT EXISTS portal_nav_labels jsonb;
