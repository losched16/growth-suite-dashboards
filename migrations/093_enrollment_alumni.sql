-- 093: 'alumni' enrollment status (graduated/moved-on students the
-- school wants to keep addressable without them appearing anywhere
-- active). Behaves like on_hold/withdrawn: excluded from every
-- enrolled/pending surface, visible under the roster's Withdrawn scope
-- and Family Hub's status filters. Applied to production 2026-08-05.

ALTER TABLE enrollments DROP CONSTRAINT IF EXISTS enrollments_status_check;
ALTER TABLE enrollments ADD CONSTRAINT enrollments_status_check CHECK (
  status = ANY (ARRAY[
    'inquiry'::text, 'tour_scheduled'::text, 'application_submitted'::text,
    'accepted'::text, 'enrolled'::text, 'waitlisted'::text,
    'withdrawn'::text, 'declined'::text, 'pending'::text,
    'on_hold'::text, 'alumni'::text
  ])
);
