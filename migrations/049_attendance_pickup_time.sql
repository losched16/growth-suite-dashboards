-- 049_attendance_pickup_time.sql
--
-- Adds a pickup_time column to attendance_events. Parents pick this at
-- morning check-in based on their student's program; staff see it on the
-- attendance dashboard so they know which dismissal wave a kid belongs to.
--
-- Format: 'HH:MM' (24h string). e.g. '14:30', '15:15', '15:30'. Storing as
-- text rather than the time type because the parent portal serializes the
-- choice directly out of an HTML form (no parsing required).

BEGIN;

ALTER TABLE attendance_events
  ADD COLUMN IF NOT EXISTS pickup_time text;

COMMENT ON COLUMN attendance_events.pickup_time IS
  'Parent-selected pickup time at check-in, format HH:MM (24h). Driven by the student''s program — typically 14:30 / 15:15 / 15:30.';

COMMIT;
