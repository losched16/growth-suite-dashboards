# School Onboarding Playbook

The end-to-end checklist for bringing a new school onto Growth Suite.
Designed to be self-contained: a new ops hire can follow this without
asking questions. Estimated time: **45-90 min per school**, mostly
waiting on the school to do KYC.

## The big picture

Every school goes through five phases. They map to columns on
`/admin/billing-status` so you can see where each tenant is at any
moment.

```
1. Provisioned    → schools row exists, default dashboards seeded
2. Roster imported → families + students + parents loaded
3. Stripe connected → payment_accounts row, charges_enabled=true
4. Tuition configured → tuition_grids + payment_plans seeded, plans live
5. Live           → billing_active=true, parents getting real invoices
```

A school is **stuck** if it sits in any phase for more than 2 weeks
without progress. The Billing Status page rose-highlights schools stuck
30+ days.

---

## Phase 1 — Provision the tenant (5 min, you click)

1. Operator logs in at `/admin` with `ADMIN_PASSWORD`
2. Click **+ Add school** in the header
3. Fill in:
   - **School name** — display only
   - **GHL Location ID** — from their GHL Settings → Business Info
   - **Private Integration Token** — from their GHL Settings → Private
     Integrations → New Token. **Required scopes:**
     ```
     contacts.readonly contacts.write
     locations/customFields.readonly
     associations.write associations/relation.write
     opportunities.readonly
     conversations.readonly conversations/message.write
     medias.write
     ```
4. Click **Create & continue**. The endpoint validates the PIT against
   GHL before storing — if it's wrong you'll see an error and nothing
   gets written.
5. You land on `/admin/{schoolId}`. The school now has:
   - A `schools` row with encrypted PIT
   - Default dashboards: Family Hub, Student Roster
   - A `school_payment_config` row with `billing_active=false` (dry-run)
   - A blank `school_branding` row

Take note of:
- The `ghl_location_id` (you'll need it for GHL custom-link setup)
- The internal `schoolId` UUID

---

## Phase 2 — Import the roster (10-30 min)

You need families, parents, and students in the database before anything
else works. Pick the path that fits the data they have:

### Path A: They already have data in GHL contacts

If the school's already in GHL with families as contacts:

1. On `/admin/{schoolId}` click **Sync from GHL**
2. Wait. Logs stream to the page; expect 1-3 min for small schools,
   10-15 min for large ones.
3. When done: spot-check by clicking **Family Hub** → confirm a few
   families look right.
4. Then click **Promote Parent 2 to GHL contacts** to create stand-alone
   P2 contact records and co-parent associations.

### Path B: FACTS Management export

If they already use FACTS for tuition / billing:

1. Get a FACTS export from them (typically 3 CSVs: Customer, Student,
   Balances).
2. Drop them into a folder you control.
3. Run `python scripts/import-facts.py --school-id {schoolId} --customer
   path/to/customer.csv --student path/to/student.csv --balances
   path/to/balances.csv`
4. The FACTS importer matches customers to families via email and
   produces a dry-run report first. Pass `--apply` to commit.

### Path C: Custom CSV / Excel

If the school has their own roster CSV (no FACTS, no GHL contacts):

1. Get their CSV. Expected columns: family_name, primary_parent_email,
   student_first_name, student_last_name, student_dob, classroom,
   program, schedule.
2. Adapt `scripts/import-mch-tuition-survey.mjs` as a template, or
   ask Clint to write a one-shot script. ~15 min of work.

### Verification after import

- `/admin/{schoolId}/family-hub` should show their families
- `/admin/{schoolId}/student-roster` should show their students
- Run a quick SQL: `SELECT COUNT(*) FROM families WHERE school_id =
  '{schoolId}'`. Should match what the school told you.

---

## Phase 3 — Connect Stripe (15-30 min, school does most of it)

The school clicks through Stripe Connect themselves. You're just there
to walk them through it.

1. Tell the school to navigate to **Payments → Settings** in their
   embedded GHL menu link
2. Two paths. They pick one:

   **They've never used Stripe →** Click **Create a new Stripe
   account**. New tab opens; they fill in business info, EIN, bank
   account routing, identity verification. 5-15 min depending on how
   prepared they are. Stripe redirects them back when done.

   **They already use Stripe →** Click **Connect existing Stripe
   account**. New tab opens to `connect.stripe.com/oauth/v2/authorize`.
   They sign in with their existing Stripe credentials, pick which
   account to connect, authorize. ~30 sec. They keep their existing
   bank account, payment methods, statement descriptor, tax setup —
   nothing changes for them.

3. After they return, the Settings pill should flip from "Not
   connected" to "Connected & accepting payments."
4. If it doesn't update immediately (sometimes the webhook is slow),
   check `/admin/webhook-log` for `account.updated` events.

### Pre-requisite check (do this ONCE for your platform)

The OAuth flow requires:
- `STRIPE_SECRET_KEY` (live: `sk_live_…`) in Vercel env
- `STRIPE_CLIENT_ID` (live: `ca_live_…`) in Vercel env
- `STRIPE_WEBHOOK_SECRET` in Vercel env
- Stripe Dashboard → Settings → Connect → OAuth enabled
- Stripe Dashboard → Settings → Connect → Redirect URIs allowlist
  includes:
  `https://growth-suite-dashboards.vercel.app/api/admin/schools/*/payments/connect-oauth/callback`
- Stripe Dashboard → Webhooks → endpoint
  `https://growth-suite-dashboards.vercel.app/api/webhooks/stripe`
  subscribed to:
  `account.updated`, `payment_intent.succeeded`,
  `payment_intent.payment_failed`, `charge.refunded`,
  `checkout.session.completed`, `invoice.paid`,
  `customer.subscription.deleted`, `payment_method.attached`,
  `payment_method.detached`, `account.application.deauthorized`

If any of these are missing, OAuth either fails silently or works in
test mode when you wanted live. Confirm by checking
`/admin/webhook-log` for events after a school connects.

---

## Phase 4 — Configure tuition (30 min - 2 hours, depends on complexity)

Each school has its own tuition structure. There's no shortcut here —
you have to enter their actual data. The good news is the data model
handles every shape we've seen.

### Step 4a — Tuition grids (the rate card)

A grid = one program/schedule combo with an annual price.

1. Get their actual rate card. PDF, Excel, whatever they have.
2. For each row in their rate card, create a grid via the SQL pattern
   in `scripts/seed-mch-tuition.mjs` (lines 100-140). Look at MCH's 11
   grids (YC × 6, Primary × 4, Kindergarten × 1) for a template.
3. There's no UI for this yet (gap #5 — coming soon). For now: copy the
   MCH seed script, swap in the new school's grids, run it.

### Step 4b — Payment plans

Each plan = installment count + discount %.

1. Look at their tuition agreement. Most schools have 1 / 2 / 10
   payment options with different discount tiers.
2. Insert into `payment_plans` table. Pattern in
   `scripts/seed-mch-tuition.mjs` lines 78-110.

### Step 4c — Family enrollments

Each family needs a `family_tuition_enrollments` row linking them to a
grid + plan.

1. Get from the school: which family picked which plan, which schedule
   for each kid. Often this is a Google Form export or a spreadsheet.
2. Adapt `scripts/import-mch-tuition-survey.mjs` as a template.
3. Run dry-run first: `node scripts/import-X-tuition.mjs --dry-run`.
   Check the output, fix any name-matching issues.
4. Run live: `node scripts/import-X-tuition.mjs`. Should report 100%
   matched.

### Step 4d — GHL custom fields

If the school wants tuition data writeback to GHL contacts:

1. Run `npx tsx scripts/create-ghl-split-billing-fields.mjs --school-id
   {schoolId}` to provision the billing share fields.
2. Also provision the per-student tuition fields:
   `student_total_tuition_cost`, `student_total_amount`,
   `student_payment_plan` for slots 1-4. (See
   `scripts/create-ghl-custom-fields.py` for the full list.)
3. Run `npx tsx scripts/writeback-mch-tuition-ghl.mjs` (adapt for new
   school) to push the data.

---

## Phase 5 — Verify and go live (school's call, days to weeks)

The school is now in dry-run mode. They see drafts; parents see nothing.

1. Tell the school's admin: "Open Payments → Tuition Plans. Click
   through every family. Verify their amounts, plan, schedule. Edit
   anything wrong using the per-enrollment editor."
2. Tell them: "You're not billing anyone yet — review for as long as
   you need. When you're confident everything's right, click the **Go
   live** button at the top of the Payments hub."
3. They type `GO_LIVE` to confirm. All draft invoices flip to open.
   Parents see them within seconds.
4. From that moment forward:
   - Parents get notification emails when invoices generate
   - Autopay runs on the next scheduled day for enrolled parents
   - The Billing Status page flips them from DRY-RUN to LIVE

---

## Common stalls and fixes

### "Webhook isn't firing"
Check `/admin/webhook-log`. If no events ever, the platform-side
Stripe webhook endpoint isn't configured. Re-check the URL +
signing secret in Stripe Dashboard.

### "School says Connect button does nothing"
Likely a popup blocker. Tell them to allow popups for
`growth-suite-dashboards.vercel.app`, then click again.

### "Parent says they don't see their invoice"
3 possibilities:
- School is still in dry-run (check `billing_active`)
- Invoice was generated for a different parent on the family (check
  `responsible_parent_id` — split billing)
- Parent's email on `parents` row is wrong (they registered with a
  different one)

### "Stripe says my client_id is invalid"
You're using the test client_id while in live mode (or vice versa).
The client_id has separate test + live values. Both must come from
the same Stripe environment.

### "Failed-payment email isn't getting to the school"
The notify email is pulled from `school_branding.support_email`. If
unset, falls back to the hardcoded MCH email (bug — should fall
back per-school. See gap #3).

---

## Phase metrics worth tracking

- **Phase 1 to Phase 2**: should be 1 day. Stalling = roster data is
  missing or scattered.
- **Phase 2 to Phase 3**: should be 1-2 days. Stalling = school admin
  is too busy / doesn't understand how to do Stripe Connect.
- **Phase 3 to Phase 4**: should be 1 day. Stalling = no rate card
  exists yet.
- **Phase 4 to Phase 5**: 1 week to 1 month. Long stalls here are
  normal (school admins want to be careful).
- **Phase 5 → first real charge**: 1 day to 1 month, depends on when
  their plan's first installment falls.

If a school is stuck in any phase >2 weeks, schedule a call.
