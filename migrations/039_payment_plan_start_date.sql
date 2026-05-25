-- 039_payment_plan_start_date.sql
--
-- Lets a school define WHEN a payment plan template starts: the
-- month + day of the first installment (e.g. "Aug 1"). The year is
-- derived from the family's academic_year at enrollment time, so a
-- template configured once works every year without manual updates.
--
-- When set, the installment generator anchors the first due date to
-- this month-day and spaces subsequent installments evenly across the
-- months[] in schedule_template (preserving day-of-month).
--
-- When NULL, behavior is unchanged: monthly schedules default to the
-- 1st of each month, single annual defaults to Aug 15.
--
-- Stored as TEXT in 'MM-DD' format (zero-padded). A CHECK constraint
-- prevents invalid values from getting into the table.

ALTER TABLE payment_plans
  ADD COLUMN IF NOT EXISTS first_due_month_day TEXT
    CHECK (first_due_month_day IS NULL
        OR first_due_month_day ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$');

COMMENT ON COLUMN payment_plans.first_due_month_day IS
  'Optional MM-DD anchor for the first installment due date. NULL = use schedule_template defaults (1st of month for monthly, Aug 15 for single annual).';
