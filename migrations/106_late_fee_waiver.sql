-- Per-invoice late-fee waiver (Clint, 2026-09-14: "these are the only ones
-- with a late fee … the rest, no late fees"). The nightly pass skips any
-- invoice with late_fee_waived_at set, across every tier. Recorded with a
-- reason so the Invoices tab can show why an overdue invoice carries no
-- fee. Waiving is per invoice, never per family: a later installment that
-- goes overdue is judged on its own.

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS late_fee_waived_at timestamptz,
  ADD COLUMN IF NOT EXISTS late_fee_waived_reason text;
