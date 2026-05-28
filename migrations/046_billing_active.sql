-- Dry-run mode per school. New schools default to dry-run: invoices
-- generate as 'draft' (parents don't see them, no notification emails),
-- and the autopay cron skips them. The school's admin reviews everything
-- against real family data, then flips billing_active=true to "go live"
-- — drafts atomically become 'open' and autopay starts working.
--
-- This is the right scaling pattern for a multi-tenant Stripe Connect
-- platform: every school is in live mode on Stripe from day one (no
-- test/live graduation event), but our app gates whether real charges
-- actually fire. Replaces the need for a separate "test deployment per
-- school" approach.

ALTER TABLE school_payment_config
  ADD COLUMN billing_active boolean NOT NULL DEFAULT false,
  ADD COLUMN billing_activated_at timestamp with time zone NULL,
  ADD COLUMN billing_activated_by_email text NULL;

COMMENT ON COLUMN school_payment_config.billing_active IS
  'When false, the school is in dry-run mode: tuition-plan-generator emits invoices with status=draft, the parent portal /billing pages filter out draft invoices, autopay cron skips the school. Flipping to true atomically converts existing drafts to open and starts the billing rhythm.';

COMMENT ON COLUMN school_payment_config.billing_activated_at IS
  'Timestamp of the first flip from billing_active=false to true. NULL while the school is still in dry-run. Persists across pause/resume cycles (we never set it back to NULL) so we can audit when the school first went live.';

-- Backfill: any school that already has paid invoices is obviously live
-- — flag them so the dry-run banner doesn't pop up on Day 1 for tenants
-- who were billing through the platform before this feature existed.
-- DGM (no real invoices yet) and MCH (no Stripe yet) stay at default
-- false; the admin clicks "Go live" when they're ready.
UPDATE school_payment_config sp
   SET billing_active = true,
       billing_activated_at = (
         SELECT MIN(i.created_at) FROM invoices i
          WHERE i.school_id = sp.school_id AND i.status = 'paid'
       ),
       billing_activated_by_email = 'backfill-046@growthsuite.local'
 WHERE EXISTS (
   SELECT 1 FROM invoices i
    WHERE i.school_id = sp.school_id AND i.status = 'paid'
 );
