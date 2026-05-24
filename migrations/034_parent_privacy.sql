-- Parent-to-parent privacy flag. Divorced/separated families have
-- scenarios where one parent doesn't want their contact info visible
-- to (or editable by) the other parent. School staff always see
-- everything; this only governs the inter-parent visibility on the
-- parent portal.
--
-- Wooster reported parents "deleting each other's info" — the most
-- common path is one parent opening a family-level form, putting in
-- their own contact details, and the submission overwrites what the
-- other parent had entered earlier. With this flag set, the protected
-- parent's record is read-only / masked in any co-parent's view.

ALTER TABLE parents
  ADD COLUMN IF NOT EXISTS is_private_from_co_parents boolean NOT NULL DEFAULT false;

-- The audit log helps us trace when / why a parent enabled or disabled
-- this flag — useful if school staff need to confirm "did Parent A
-- actually mark themselves private, or did Parent B sneak in?"
COMMENT ON COLUMN parents.is_private_from_co_parents IS
  'When true, this parent''s contact details are hidden from other parents in the same family in the parent portal. School staff always see the full record.';
