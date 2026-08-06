-- 096: office-only notes on a student's daily attendance row (Clint,
-- Aug 6: "make the notes editable from the dashboard where admins can
-- make notes. But please don't make admin notes available for parents
-- to see"). Edited from the Attendance dashboard; NEVER surfaced in the
-- parent portal (parent attendance reads status/times/event notes only).
--
-- Unlike custom_status, a real check-in/out does NOT clear the note —
-- the 090/091 recompute trigger doesn't touch these columns, so "grandma
-- picking up at 2pm" survives the actual 2pm checkout event.

ALTER TABLE daily_attendance
  ADD COLUMN IF NOT EXISTS admin_notes text,
  ADD COLUMN IF NOT EXISTS admin_notes_updated_at timestamptz;
