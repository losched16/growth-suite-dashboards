-- Late fees on tuition only (Clint, 2026-09-29: "Pizza, supply fees and
-- field fees should not have a late fee"). When set, the parent-portal
-- nightly late-fee pass only considers tuition-plan installments; one-off
-- invoices (bulk or manual — pizza, supplies, field trips, before care,
-- registration) are never fee'd. Per school, default off, so schools that
-- do fee one-off charges keep their current behaviour.

ALTER TABLE school_payment_config
  ADD COLUMN IF NOT EXISTS late_fee_tuition_only boolean NOT NULL DEFAULT false;
