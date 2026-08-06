-- 095: pickup-person uniqueness becomes per OWNER (adding parent), not
-- per family. Split families keep separate per-household pickup lists —
-- both households may legitimately authorize the same grandma, one row
-- each, hidden from the other household's portal. Still blocks real
-- duplicates within one parent's list. Applied to production 2026-08-06.

DROP INDEX IF EXISTS pickup_persons_no_dupes_active;
CREATE UNIQUE INDEX pickup_persons_no_dupes_active
  ON pickup_persons (school_id, family_id, added_by_parent_id, lower(name))
  WHERE (active = true);
