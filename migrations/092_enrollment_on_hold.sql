-- 092: 'on_hold' enrollment status. Offices use "Hold" on the contact
-- for students who are neither attending nor withdrawn; the sync
-- previously didn't recognize it (warning + no enrollment row), which
-- left Hold students invisible to status logic — they leaked into
-- every active-student surface. Now a first-class status: excluded from
-- enrolled/pending views everywhere, surfaced under the roster's
-- Withdrawn scope and Family Hub's withdrawn/all filters.

ALTER TABLE enrollments DROP CONSTRAINT IF EXISTS enrollments_status_check;
ALTER TABLE enrollments ADD CONSTRAINT enrollments_status_check CHECK (
  status = ANY (ARRAY[
    'inquiry'::text, 'tour_scheduled'::text, 'application_submitted'::text,
    'accepted'::text, 'enrolled'::text, 'waitlisted'::text,
    'withdrawn'::text, 'declined'::text, 'pending'::text, 'on_hold'::text
  ])
);
