-- Per-school discount rules so a plan change can AUTO-RECOMPUTE percentage
-- discounts against the new tuition base, instead of leaving stale fixed
-- dollar amounts behind.
--
-- Shape (school_payment_config.discount_rules JSONB):
--   {
--     "version": 1,
--     "basis": "base_plus_extended_care",     -- what the % applies to
--     "compounding": false,                    -- each discount off the same base
--     "extended_care_keys": ["extended_care"], -- addon keys that count toward basis
--     "carry_over_keys": [...],                -- addons copied forward as-is (fixed $)
--     "pay_timing_by_plan": {                  -- discount that depends on the plan
--       "annual":      { "key": "...", "label": "...", "bps": 300 },
--       "semi-annual": { "key": "...", "label": "...", "bps": 200 },
--       "monthly":     null
--     },
--     "sibling": { "key": "sibling_discount", "label": "...", "bps": 1000 }  -- sticky
--   }
-- A null/empty value means "no auto-recompute" — the change-plan editor then
-- carries discounts forward untouched and flags them for manual review.

ALTER TABLE school_payment_config
  ADD COLUMN IF NOT EXISTS discount_rules jsonb;

-- Media Children's House — school-confirmed formula:
--   discountable = base grid tuition + extended care (non-compounding)
--   3% paid-in-full (annual) | 2% semi-annual (2-pay) | 10% sibling (sticky)
--   total = base + extended care − deposit − discounts + development fee
UPDATE school_payment_config
   SET discount_rules = $JSON${
     "version": 1,
     "basis": "base_plus_extended_care",
     "compounding": false,
     "extended_care_keys": ["extended_care"],
     "carry_over_keys": ["extended_care", "deposit", "development_fee", "scholarship"],
     "pay_timing_by_plan": {
       "annual":      { "key": "prompt_pay_discount", "label": "Paid-in-full discount (3%)", "bps": 300 },
       "semi-annual": { "key": "semi_annual_discount", "label": "Semi-annual discount (2%)", "bps": 200 },
       "monthly":     null
     },
     "sibling": { "key": "sibling_discount", "label": "Sibling discount (10%)", "bps": 1000 }
   }$JSON$::jsonb,
       updated_at = now()
 WHERE school_id = 'a6c4b2dd-050c-4bf9-893b-67106f0f20e8'
   AND discount_rules IS NULL;
