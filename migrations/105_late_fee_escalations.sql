-- Tiered late fees (Clint, 2026-09-14). NLMA's policy: $50 once an invoice
-- is 10 days late, $75 TOTAL at 15 days, $100 TOTAL at 20 days.
--
-- late_fee_amount_cents + late_fee_grace_days stay exactly what they were:
-- the first tier and the master switch (amount $0 = late fees off).
-- late_fee_escalations adds the later tiers as [{after_days, total_cents}].
-- Each tier is the TOTAL the invoice should carry once it is that many days
-- overdue — cumulative, never additive — so the nightly pass adds only the
-- difference between that and what the invoice already carries.
--
-- invoices.late_fee_applied_cents is that "already carries" number. Until
-- now the pass keyed on late_fee_applied_at IS NULL, which can only ever
-- express one flat fee; a running total is what tiers need. Invoices that
-- already have a 'Late fee' line start from its amount so nobody is fee'd
-- twice on the day this ships.

ALTER TABLE school_payment_config
  ADD COLUMN IF NOT EXISTS late_fee_escalations jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS late_fee_applied_cents integer NOT NULL DEFAULT 0;

UPDATE invoices i
   SET late_fee_applied_cents = sub.cents
  FROM (SELECT invoice_id, SUM(amount_cents)::int AS cents
          FROM invoice_line_items
         WHERE description ILIKE 'Late fee%'
         GROUP BY invoice_id) sub
 WHERE sub.invoice_id = i.id
   AND i.late_fee_applied_cents = 0;
