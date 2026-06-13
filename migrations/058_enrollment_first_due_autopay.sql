-- 058: school-chosen first payment date + autopay-on-by-default.
--
-- (1) family_tuition_enrollments.first_due_date — the school sets WHEN
--     the first tuition installment drafts (e.g. sign June 13, first
--     payment July 1). Anchors the whole installment schedule. NULL =
--     fall back to the academic-year default (July 1).
--
-- (2) school_payment_config.autopay_default_on — when true (default),
--     tuition installment invoices are created with autopay_enabled so
--     the moment a family saves a card, drafting happens automatically
--     and the school never hand-sends a tuition invoice. Schools that
--     want opt-in autopay can flip this off.

ALTER TABLE family_tuition_enrollments
  ADD COLUMN IF NOT EXISTS first_due_date date;

ALTER TABLE school_payment_config
  ADD COLUMN IF NOT EXISTS autopay_default_on boolean NOT NULL DEFAULT true;
