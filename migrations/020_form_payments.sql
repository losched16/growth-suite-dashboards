-- Payments Phase 3 — form/invoice integration.
--
-- A form definition can now declare a payment_config that says:
--   - whether this form requires payment to submit
--   - how to derive invoice line items from the form's responses
--
-- payment_config jsonb shape (operator-editable later, hand-edited for v1):
--   {
--     "mode": "required" | "optional",       -- required = no submit without paying
--     "invoice_title_template": "{form_name} for {student_name}",
--     "lines": [
--       { "kind": "fixed", "label": "Application fee", "amount_cents": 5000 },
--       { "kind": "field", "field_key": "tuition_calc", "label_template": "{label}" },
--       { "kind": "pricing_select", "field_key": "ticket_type" },
--       { "kind": "multi_pricing", "field_key": "addons" }
--     ],
--     "due_days_from_submission": 0,
--     "includes_platform_setup_fee": true | false (auto-decide if omitted)
--   }
--
-- When the parent submits, the engine:
--   1. Evaluates each line against responses (fixed = literal; field =
--      look up the field's selected option's price; pricing_select +
--      multi_pricing = sum of selected options' prices).
--   2. Creates an invoice in 'open' status with those line items.
--   3. Redirects parent to /billing/pay/{invoice_id}?return_to=/forms-v2/...
--   4. Submission is marked status='pending_payment' until the invoice
--      is paid (webhook flips it to 'submitted').

ALTER TABLE portal_form_definitions
  ADD COLUMN IF NOT EXISTS payment_config jsonb;

-- Link a submission to its invoice so the webhook can resolve back.
ALTER TABLE portal_form_submissions
  ADD COLUMN IF NOT EXISTS invoice_id uuid REFERENCES invoices(id) ON DELETE SET NULL;

-- We already have a `pending_payment` status from migration 013. Good.

CREATE INDEX IF NOT EXISTS idx_portal_form_submissions_invoice
  ON portal_form_submissions (invoice_id) WHERE invoice_id IS NOT NULL;

-- Track the source on invoices created from form submissions so we can
-- close the loop (reverse-lookup which submission an invoice came from
-- via source_ref jsonb).
COMMENT ON COLUMN invoices.source IS
  'manual | form_submission | tuition_plan | enrollment_deposit | autopay_installment';
COMMENT ON COLUMN invoices.source_ref IS
  'For form_submission: { submission_id: uuid, form_definition_id: uuid }';
