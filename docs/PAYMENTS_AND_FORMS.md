# Growth Suite — Payments & Forms Reference

The single-source-of-truth document for the **payments** and **forms** systems. Two audiences in one doc:

- **Internal** (engineers, ops, support): full data model, route map, downstream effects, env vars, gotchas. Search for `[INTERNAL]` tags.
- **External** (school staff & onboarding): what each feature does, where to click, how to configure it. Search for `[EXTERNAL]` tags.

Last refreshed at the time of the most recent migration (`042_form_webhooks.sql`). When you change anything material below, bump this doc in the same commit.

---

## Table of contents

1. [Two namespaces, one app](#two-namespaces-one-app)
2. [Auth model](#auth-model)
3. [Payments — the big picture](#payments--the-big-picture)
   - [Stripe Connect](#stripe-connect)
   - [Tuition plan templates](#tuition-plan-templates)
   - [Tuition grids](#tuition-grids)
   - [Family enrollments](#family-enrollments)
   - [Editing a family's plan](#editing-a-familys-plan)
   - [Invoices](#invoices)
   - [Products catalog](#products-catalog)
   - [Discounts](#discounts)
   - [FACTS import](#facts-import)
   - [GHL writeback for tuition](#ghl-writeback-for-tuition)
4. [Forms — the big picture](#forms--the-big-picture)
   - [Field schema](#field-schema)
   - [After a parent submits](#after-a-parent-submits)
   - [Custom thank-you message + redirect](#custom-thank-you-message--redirect)
   - [Office notification emails](#office-notification-emails)
   - [Webhook fan-out / automation triggers](#webhook-fan-out--automation-triggers)
   - [GHL writeback](#ghl-writeback-for-forms)
   - [Test mode (preview)](#test-mode-preview)
   - [Submissions inbox](#submissions-inbox)
5. [End-to-end flows](#end-to-end-flows)
6. [Migrations index](#migrations-index)
7. [Env vars](#env-vars)
8. [Operator playbook — common tasks](#operator-playbook--common-tasks)
9. [Troubleshooting](#troubleshooting)

---

## Two namespaces, one app

The dashboards app exposes the same surface under two URL namespaces:

| Namespace | Audience | How it loads | Iframe-safe |
|---|---|---|---|
| `/admin/[schoolId]/...` | Growth Suite operators (us) | Direct browse | n/a |
| `/school/[locationId]/...` | School staff inside the GHL CRM iframe | GHL Custom Menu Link → our proxy auto-mints a session cookie from the locationId in the path | yes |

`schoolId` is our internal UUID; `locationId` is the GHL location ID. The proxy resolves one to the other.

**[INTERNAL]** Every school-side page is a thin wrapper around the operator page's components (`FormEditor`, `ProductForm`, `LineItemsEditor`, etc.) so we don't double-maintain UI. Wrappers pass `returnPathBase` / `return_to` so successful actions land back inside the iframe namespace.

**[EXTERNAL]** Everything you do as school staff lives under `/school/...`. You never need to leave the iframe. If you ever see `/admin/...` in a URL bar, ping support — that's an iframe-escape bug.

---

## Auth model

| Surface | Session cookie | Verified by |
|---|---|---|
| Operator UI (`/admin/...`) | HMAC-signed `gsd_session` cookie (operator login) | `lib/auth/operator.ts` |
| School iframe (`/school/...`) | JWT `gsd_school_session` cookie minted from the GHL location_id by the proxy | `lib/auth/school.ts` |
| Mutating APIs under `/api/admin/schools/[schoolId]/...` | **Dual auth**: accepts EITHER an operator session OR a school session whose `school_id` matches the URL | `lib/auth/dual.ts` (`authorizeOperatorOrSchool`) |
| Parent portal (separate repo `growth-suite-parent-portal`) | Parent JWT (magic-link login) | `lib/identity.ts` (parent portal) |

**[INTERNAL]** Dual auth returns `403 forbidden_cross_school` (not 401) when a valid school session targets a different school — keep that distinction so audit can spot cross-school probe attempts.

**[EXTERNAL]** You authenticate by clicking into the Growth Suite menu link from your GHL portal. The session lasts 8 hours and refreshes silently if it expires.

---

# Payments — the big picture

```
┌─────────────────┐ runs through ┌──────────────────────┐
│  Parent portal  │ ───────────► │ Stripe Connect       │
│  (parent-facing)│              │ (school's account)   │
└─────────────────┘              └──────────────────────┘
        ▲                                  │
        │ creates invoices                 │ webhook
        │                                  ▼
┌─────────────────┐              ┌──────────────────────┐
│ Dashboards app  │ ◄─────────── │ stripe_webhook_log   │
│ (school staff)  │              │  → updates invoices, │
└─────────────────┘              │    enrollments, etc. │
                                 └──────────────────────┘
```

The dashboards app **manages** invoices, plans, and grids. Parents **pay** them through the parent portal's Stripe-hosted checkout. Stripe Connect on the school's account is where the money settles.

## Stripe Connect

**[EXTERNAL]** Each school has its own Stripe account. Money settles directly to the school's bank account. Growth Suite is wired in via Stripe Connect as a "platform" — we route a small application fee per charge but don't touch the principal.

**To get live:**

1. School view → **Payments → Settings tab → "Connect with Stripe"**.
2. Fill out Stripe's Standard Connect onboarding (business info, bank account, identity verification).
3. The pill at the top of every Payments tab shows your current state:
   - **Not connected** — gray pill, no Stripe account linked
   - **Onboarding** — blue pill, you've started but Stripe needs more info
   - **Needs info** — amber pill, Stripe flagged specific requirements (click "Resolve in Stripe")
   - **Live** — emerald pill, you're accepting payments
4. You can't take real money until the pill is **Live**.

**Nothing manual to set up inside Stripe**: no products, prices, customers, or subscriptions to create by hand. Our app creates everything programmatically when needed.

**[INTERNAL]**

- Connect onboarding lives at `lib/stripe/connect-onboarding.ts`. Helpers: `loadPaymentAccount`, `syncStripeAccountState`, `createOnboardingLink`.
- Webhook endpoint: `/api/webhooks/stripe` (parent-portal repo). Verifies signature via `STRIPE_WEBHOOK_SECRET`, dispatches to per-event handlers. Idempotency via `stripe_webhook_log` table (event id is unique).
- Connect account state is cached in `school_payment_accounts` and resynced on every Settings page load (cheap — single API call).

## Tuition plan templates

A **plan template** describes HOW a family pays — number of installments, optional prompt-pay discount, and an optional anchor date for the first payment. The actual dollar amounts come from the family's tuition grid.

**[EXTERNAL]**

Where: **Payments → Tuition Plans tab → Payment plan templates section** (at the top).

Each template has:
- **Display name** — what parents see in the plan picker (e.g. "10 Monthly Payments")
- **Slug** — internal id (lowercase, hyphens), used in URLs and API calls
- **Installments** — `1` for annual, `2` semi-annual, `4` quarterly, `10` for Aug–May, `12` for full year, or any custom value 1–36
- **First payment due** — optional anchor date (e.g. `Aug 1`). The system stores month + day only; the year is auto-derived from the family's academic year, so the template configured once works every year. Leave blank to fall back to the 1st of each month (or Aug 15 for single annual).
- **Prompt-pay discount %** — discount applied to the total tuition when this plan is chosen. Use it to reward families who pay upfront.
- **Active toggle** — inactive templates are hidden from new enrollments but preserved in history.

**Buttons:**
- **Edit** (per row) — expands the row inline with every field editable, including installment count. Existing enrolled families keep their already-generated invoices — only NEW enrollments use the new schedule.
- **Add a new payment plan template** (collapsible at the bottom) — slug + name + installment count + first-due-date + discount + description in one form. The installment schedule (which months get billed) is auto-generated.
- **Deactivate** — hides the template from new enrollments. Existing families on it are unaffected. You cannot hard-delete a template that's in use — use deactivate.
- **Seed 4 default plans** (visible only when zero templates exist) — one-click adds Annual (2.5% discount), Semi-annual, Quarterly, and Monthly × 10.

**[INTERNAL]**

- Table: `payment_plans` (migration 016, extended by 039 for `first_due_month_day`).
- Schedule JSON shape: `schedule_template jsonb` — `{kind: 'single'}` | `{kind: 'monthly' | 'semiannual', months: ['08', '09', ...]}` | `{kind: 'custom', dates: ['2026-08-15', ...]}`.
- `first_due_month_day text` — `'MM-DD'`, CHECK-constrained. `lib/billing/tuition-plan-generator.ts` `computeDueDates` honors it by rotating the schedule's months array so the anchor month is first, then applying the anchor day across all months (with smart day-of-month clamping for short months).
- API: `POST /api/admin/schools/[schoolId]/payments/plans` with `op=add|update|delete|seed_defaults`. Dual-authed. Accepts `return_to` form field to redirect into the school iframe.

## Tuition grids

**[EXTERNAL]** A **tuition grid** is one program × grade level × annual price. e.g. "Toddler/Primary — Half Day @ $9,500/yr". Each grid belongs to one academic year. Schools usually have one grid per program × grade combination per year.

Today these are configured by Growth Suite ops during onboarding (operator UI: `/admin/[schoolId]/payments`, "Tuition grids" section). They drive: (a) the dollar amounts in the parent's plan picker, and (b) what's selectable in the invoice catalog dropdown.

**[INTERNAL]**

- Table: `tuition_grids` (migration 016).
- Columns: `academic_year`, `program`, `grade_level`, `display_name`, `annual_tuition_cents`, `position`, `is_active`, `addons jsonb` (each addon = `{key, label, amount_cents, required?}`).
- DGM grids were reseeded from the enrollment agreement (task #17). See `scripts/_reseed_dgm_tuition.mjs`.
- API: `POST /api/admin/schools/[schoolId]/payments/tuition-grids` with `op=add|update|delete`. Operator-only today (no school-side editor yet — that's task #36-style follow-up if needed).

## Family enrollments

A **family enrollment** binds one family + one student (optional) + one academic year + one tuition grid + one payment plan template. Creating an enrollment generates all the installment invoices for the year.

**[EXTERNAL]**

Where: **Payments → Tuition Plans tab → Family enrollments section** (below templates).

Each row shows: family, program × plan, year, annual total, progress bar (paid / total installments), status (active / paused / completed / cancelled).

**To start a new enrollment, two ways:**

1. **"Start an enrollment" button** (top right of the section). Takes you to `/school/[locationId]/enrollments/start` — a wizard that sends the parent a magic link. Parent logs into the portal, picks a plan via the Tuition Plan Picker, plan is created automatically.
2. **Have the parent self-enroll** by sending them their portal link directly. They land on `/tuition` in their portal where they see all active plan templates with live per-installment math.

**Clicking any family row** opens the per-family plan editor (next section).

**[INTERNAL]**

- Table: `family_tuition_enrollments` (migration 022).
- The generator (`lib/billing/tuition-plan-generator.ts`) is invoked from `/api/admin/schools/[schoolId]/payments/enrollments` (operator) and from the parent's plan-picker submit endpoint. It: (1) upserts the enrollment row, (2) deletes any prior draft/open invoices for that enrollment, (3) computes due dates from `schedule_template + first_due_month_day + academic_year`, (4) splits the discounted annual total across installments (remainder on the last one — parent always pays exact total, no rounding loss), (5) creates one invoice per installment with `source='tuition_plan'` and `source_ref = {enrollment_id, installment_number}`.
- The `addons` snapshot is captured at enrollment time on `family_tuition_enrollments.addons` so a later grid edit doesn't retroactively change what the family owes.

## Editing a family's plan

**[EXTERNAL]**

Click any family row in the **Family enrollments** table. The plan detail page lets you:

- **Edit installment** — change due date AND amount of any single open installment.
- **Split installment** — break one installment into two with custom dates + amounts (e.g. "$500 due 3/1" → "$250 due 3/15 + $250 due 3/30"). The original is voided; two new invoices replace it.
- **Reschedule remaining balance** — void all unpaid installments and respread the outstanding balance across N new ones with monthly / biweekly / weekly cadence and a custom start date. Use this for hardship plans (e.g. 10-pay → 15-pay).
- **Pause / Resume the plan** — stops/restarts autopay rhythm. Invoices stay live; you can edit them while paused.
- **Add one-off charge / credit** — for late fees, refunds, hardship adjustments.

Paid and partially-paid invoices are always preserved as-is by the bulk operations.

**[INTERNAL]**

- Page: `/school/[locationId]/payments/plans/[enrollmentId]` (mirror of `/admin` version).
- API: `POST /api/admin/schools/[schoolId]/tuition-plans/[enrollmentId]/action` — single dispatcher for `pause | resume | edit_installment | split_installment | reschedule_remaining`. Dual-authed (was missing auth pre-`526324f`). `return_to` form field honored.
- `withTransaction` wraps every multi-step action so failures roll back cleanly. The invoice-number allocator (`nextInvoiceNumber`) reads + increments `school_payment_config.next_invoice_number` atomically inside the txn.

## Invoices

**[EXTERNAL]**

Where: **Payments → Invoices tab**.

Lists every invoice with filters: status (open / partial / paid / voided), age (overdue, due-soon, future), family search.

**Create a new invoice:** Top-right button → **Create invoice**. Fields:

- **Family** (dropdown)
- **Title** (required) — what parents see at the top of the invoice
- **Due date** (defaults to today + 14 days)
- **Description** (optional internal note)
- **Line items** — the meat of the invoice. There's a blue **"Add from catalog"** dropdown above the table, grouped by:
  - **Tuition programs** — adds the full annual amount as one line (edit quantity to bill a portion)
  - **Products** — adds the configured price ($0 for donation products — you fill in the amount)
  - **Fees** — quick-add for $25 family setup fee and $25 late fee
  Every field stays editable after selection. Use **"Add custom line"** for one-off charges that aren't in the catalog.
- **Include $25 family setup fee** — auto-checked if the family hasn't paid it yet. Disabled if already collected.
- **Send to parent immediately** — when unchecked, the invoice is saved as a draft.
- **Discounts** (collapsible) — auto-policies (sibling, FA, early-bird) evaluate automatically against the family + line categories. Optional redemption code field for code-gated discounts.

**[INTERNAL]**

- Tables: `invoices` (header), `invoice_line_items` (rows), `invoice_payments` (transactions). Migrations 016, 018.
- Catalog loader: `lib/billing/invoice-catalog.ts` shapes products + grids into the `CatalogItem` format the `LineItemsEditor` consumes. Donations seed with $0 to force a typed amount; recurring products get a hint that it creates a one-off line.
- Discount evaluation: `lib/billing/discounts.ts`. Auto-policies match `families.metadata.sibling_count`, `families.financial_aid_pct`, etc. Code-gated policies require the literal `redemption_code` form field.
- Invoice numbering: `school_payment_config.next_invoice_number` + `invoice_number_prefix` (e.g. `INV-000123`).
- Autopay: `invoices.autopay_payment_method_id` + `autopay_charge_on date`. Background job in cron picks up due autopays daily, charges via Stripe Connect on the school's account, updates invoice state via the standard webhook handler.

## Products catalog

**[EXTERNAL]**

Where: **Payments → Catalog tab** (KPI strip + recent products), or **Payments → Catalog → Manage all products** for the full editable list at `/school/[locationId]/payments/products`.

A **product** is anything you charge for that isn't tuition — event tickets, donations, supplies, summer programs, registration fees, lunch programs.

**Three product types:**

| Type | Behavior | Example |
|---|---|---|
| **One-time** | Charges a fixed amount once. | $150 field-trip ticket |
| **Recurring** | Creates a Stripe subscription that bills monthly or yearly on a configurable schedule. | $80/month after-school care |
| **Donation** | Pay-what-you-want. Optional suggested amounts; optional minimum. | Annual fund gift |

**Each product gets:**

- A unique **public URL** like `https://growth-suite-parent-portal.vercel.app/pay/your-school/<slug>`. Drop it in an email, a GHL form's "Thank you" redirect, a social post, your school's website — anyone with the link can pay.
- **Availability** control: parents-only (logged in), public (no login), or both.
- **Per-student toggle** — when on, parents pick which child the charge applies to (the chosen student gets recorded on the purchase).
- **GHL writeback field** (optional) — a custom field key on the parent's GHL contact that gets updated when they purchase.
- **Internal note** — staff-only.

**Buttons:**
- **Create product** (top right of the catalog page).
- **Edit** (per row) — full form with image upload, description, schedule, etc.
- **Deactivate** — hidden from public link views and the parent portal store, but old purchases preserved.

**The Catalog tab** also surfaces top-line stats (active count, lifetime purchases, lifetime revenue) and the most recent 12 products as a grid for quick access.

**[INTERNAL]**

- Tables: `school_products` + `product_purchases` (migration 037).
- API: `POST /api/admin/schools/[schoolId]/products` (create), `PATCH /api/admin/schools/[schoolId]/products/[productId]` (update), `DELETE` (soft delete by default; `?hard=1` rejected if any purchases exist). All dual-authed.
- Public hosted pay page: `app/pay/[schoolSlug]/[productSlug]/page.tsx` (parent-portal repo). Creates a Stripe Checkout Session on the school's Connect account; success URL writes the `product_purchases` row via the webhook.
- Recurring products create real Stripe Subscriptions on the school's account. Parents can cancel from `/billing/subscriptions/` in their portal (cancel-at-period-end pattern).
- GHL writeback on purchase: `lib/ghl/product-writeback.ts` (parent-portal repo).

## Discounts

**[EXTERNAL]**

Where: **Payments → Discounts tab**.

Three discount types:

- **Auto** — fires automatically when conditions match (e.g. "10% off when `sibling_count >= 2`"). No parent action needed.
- **Code** — requires the parent to enter a redemption code (e.g. `WELCOME50`). Optional max-total-redemptions cap.
- **Financial aid** — per-family % off, set on the family record. Surfaces on every tuition invoice automatically.

Each policy can be scoped to specific line categories (e.g. `tuition` only, not `fee`). The discount engine evaluates against the line items and the family's metadata at invoice-creation time.

**[INTERNAL]** Table: `discount_policies`. Engine: `lib/billing/discounts.ts`. Discounts are stored as additional invoice line items with negative amounts so they remain visible to the parent.

## FACTS import

**[EXTERNAL]**

Schools migrating from FACTS Tuition Management can bring their existing tuition data over via the **Payments → Settings → FACTS Import wizard** (3 steps: paste CSV → map columns → preview → commit). Imports family + student records, current balance, paid amounts.

**[INTERNAL]** Lives at `/admin/[schoolId]/payments/facts-import` (operator only). Core: `lib/billing/facts-import.ts`. Migration 038. Writes get committed in a single transaction; preview step shows diffs without writing.

## GHL writeback for tuition

**[INTERNAL]** `lib/billing/tuition-ghl-writeback.ts` pushes total tuition + per-program amounts to the parent's GHL contact record when an enrollment is created or updated. Fields used: `total_tuition_cost`, `program_tuition`. No-overwrite policy: existing non-empty values are not clobbered. Configurable per-school via the field-schema registry.

---

# Forms — the big picture

```
┌──────────────────────┐
│ School staff         │ design forms in the editor
│ (dashboards iframe)  │ /school/.../forms/[id]
└──────────────────────┘
        │ field_schema, payment_config,
        │ ghl_writeback, notify_emails,
        │ webhook_urls, confirmation_*
        ▼
┌──────────────────────┐
│ portal_form_         │
│ definitions          │
└──────────────────────┘
        │
        │ parent fills + submits
        ▼
┌──────────────────────┐
│ Parent portal        │ /forms-v2/[slug]
│ FormRenderer         │ POSTs to /api/portal-forms/submit
└──────────────────────┘
        │
        │ persists portal_form_submissions row
        ▼
┌──────────────────────┐    fan-out (fire-and-forget)
│ Post-submit          │ ──► office notification email(s)
│ effects              │ ──► webhook POSTs (Zapier/GHL/etc.)
│                      │ ──► GHL contact-field writeback
│                      │ ──► invoice creation (if payment_config)
│                      │ ──► PDF receipt email (enrollment forms)
└──────────────────────┘
        │
        ▼
┌──────────────────────┐
│ /forms-v2/thanks/[id]│ renders confirmation_message,
│                      │ auto-redirects if configured
└──────────────────────┘
```

## Field schema

**[EXTERNAL]**

Where: **Payments → Forms tab → click any form → Edit**. The form editor lives at `/school/[locationId]/forms/[formId]`.

Each form has:
- **Display name** — what parents see at the top
- **Description** — 1-2 sentences shown under the title
- **Category** — `enrollment` / `medical` / `permission` / `release` / `legal` / `trip` / etc. Affects sort order in lists.
- **Toggles**:
  - **Active** — when off, parents can't fill it
  - **Per-student** — parent picks which child this is for; form repeats
  - **Allow addendum** — parents can submit partial updates instead of a fresh full submission
  - **Resubmission allowed** — parent can submit a new full version
  - **One per year** — locks the form after the first submission this academic year
  - **Needs review** — surfaces in admin review queue

**Fields you can add:**

| Type | Use for |
|---|---|
| Header | Large section title |
| Paragraph | Explanatory text (with optional `note` / `warning` styling) |
| Section | Visual divider with label + optional description |
| Text / Long text | Free-form text input |
| Email / Phone / URL | Validated string inputs |
| Number / Date | Typed inputs |
| Dropdown / Radio | Single choice from options |
| Checkbox | Single toggle |
| Multi-checkbox | Multiple choices |
| File upload | Up to 10MB per file (PDFs, images) |
| Signature (drawn) | Touch/mouse signature pad — stored as PNG data URL |
| Signature (typed name) | Type-your-name with an optional acknowledgment paragraph |
| Pricing (single / multi / quantity) | Priced options that contribute to a total |
| Tuition calculator | Live per-installment math built into the form |

Click any field to expand and edit label, key, required-ness, help text, options (for choice types), placeholder, max length, etc.

**[INTERNAL]** Stored as `field_schema jsonb` on `portal_form_definitions`. PATCH endpoint at `/api/admin/schools/[schoolId]/forms/[formId]` validates the schema array shape but is permissive on field-level keys. Renderer parity is best-effort — when a new block type ships, update both `app/(portal)/forms-v2/[slug]/FormRenderer.tsx` (parent portal) and `app/admin/[schoolId]/forms/[formId]/preview/FormPreviewRenderer.tsx` (dashboards preview).

## After a parent submits

This section in the form editor controls the post-submit experience. **All four sub-fields are testable end-to-end via Test mode (covered below).**

### Custom thank-you message + redirect

**[EXTERNAL]**

- **Custom thank-you message** (textarea, optional) — plain text shown to the parent after they submit. Line breaks are preserved. Example: *"Thanks for completing this form! Our office will review and reach out within 2 business days."*
- **Redirect URL** (optional, must start with `https://`) — if set, the parent's thank-you page shows your message for 3 seconds then auto-redirects to this URL. Useful for sending parents to your school's own "next steps" page after enrollment.

When both are blank, parents see the default "Thanks — we got your form!" message.

**[INTERNAL]** Columns `confirmation_message text`, `confirmation_redirect_url text` on `portal_form_definitions` (migration 040). API rejects non-https redirect URLs. The parent-portal `/forms-v2/thanks/[id]` page renders both, with an HTML `<meta http-equiv="refresh">` for the auto-redirect (works without JS) plus an accelerated client-side "Continue now" button.

### Office notification emails

**[EXTERNAL]**

- **Notify these office emails when a submission arrives** (comma-separated) — list of staff addresses that receive an email summary with every real submission. Each address gets its own email (one fail doesn't block the others).

The email contains: form name, family label, parent contact info, student name (if per-student), and a table of every submitted field key → value. Sent through the school's branded sender (configured in Stripe Connect / SES config).

**[INTERNAL]** Column `notify_emails text[]` on `portal_form_definitions` (migration 040). API validates each entry with a permissive RFC regex. Send happens in `lib/forms/post-submit-effects.ts` (parent-portal repo) — `Promise.allSettled` so one failure doesn't suppress others. Template is in `lib/forms/notification-email.ts` (dashboards repo, structurally mirrored in `post-submit-effects.ts` for now — keep both in sync until we extract a shared package).

### Webhook fan-out / automation triggers

**[EXTERNAL]**

- **Webhook URLs / automation triggers** (one per line, https only) — list of URLs that receive a JSON POST every time a real submission arrives. Drop in your Zapier hook, Make webhook, GHL inbound webhook, n8n endpoint, your own backend, etc.

The payload looks like:

```json
{
  "event": "form.submitted",
  "submission_id": "uuid",
  "form": {
    "id": "uuid",
    "slug": "tuition-enrollment-2026-27",
    "display_name": "Tuition Enrollment 2026-27",
    "category": "enrollment"
  },
  "school": {
    "id": "uuid",
    "ghl_location_id": "abc123",
    "name": "Desert Garden Montessori"
  },
  "family": {
    "id": "uuid",
    "parent_id": "uuid",
    "student_id": "uuid or null"
  },
  "responses": {
    "field_key_1": "value",
    "field_key_2": ["multi", "value"],
    "...": "..."
  },
  "submitted_at": "2026-05-15T18:32:00.000Z"
}
```

Each URL gets a **5-second timeout**. If your webhook is slow or returns a non-2xx, the parent's submission still succeeds — we log the failure and move on. Fire-and-forget by design.

**Examples:**

- **Zapier**: create a Catch Hook trigger → paste the URL into Growth Suite. The Zap fires every time the form is submitted.
- **GHL Inbound Webhook**: in GHL → Automations → Add Trigger → Inbound Webhook → copy URL → paste into Growth Suite. Use the payload's `responses.field_key` paths to populate contact fields, tags, opportunities, etc.
- **Your own backend**: stand up a POST endpoint, verify the `User-Agent: GrowthSuite-FormWebhook/1` header, parse the JSON, react.

**[INTERNAL]** Column `webhook_urls text[]` on `portal_form_definitions` (migration 042). API validates `^https://` only (no http/javascript/data). Fan-out lives in `lib/forms/post-submit-effects.ts` (parent-portal repo); uses `AbortController` for the timeout and `Promise.allSettled` so all URLs fire in parallel. No retry today — if reliability matters, point your webhook URL at a queue.

### GHL writeback for forms

**[INTERNAL]** Separate from the `webhook_urls` fan-out. `ghl_writeback jsonb` column on `portal_form_definitions` is an array of `{field_key, ghl_field_key, per_student?}` mappings. On each real submission, the parent-portal handler reads the parent's GHL contact and writes the mapped fields. No-overwrite policy is enforced upstream (existing non-empty values aren't clobbered). Per-student writes use the `student_<N>_<key>` slot pattern.

This is configured separately by the operator (today) — not in the school-staff form editor. School staff can SEE which fields will be written via the test-mode dry-run report.

## Test mode (preview)

**[EXTERNAL]**

The big one. Lets you submit a form as if you were a parent, see exactly what they'd see, AND see what would happen behind the scenes — without sending real emails, firing real webhooks, charging real money, or polluting the real submissions inbox.

**To enter Test mode:**

1. From the form editor, click **Preview layout** (top right). This opens a read-only preview with an amber banner.
2. Click **"Enter test mode"** in the banner. The banner turns emerald, all fields become live, the submit button becomes active.
3. Fill in fields. Hit **Submit test**.

**You land on the result page**, which splits in two:

**TOP (blue card) — what your parent will see:**
- The configured custom thank-you message (or the default if none set)
- A note about the configured auto-redirect URL (suppressed in test mode so you can review)

**BOTTOM (grey card) — "Behind the scenes" dry-run report:**

| Section | What it shows | What would have happened in production |
|---|---|---|
| Submitted responses | Every field key → value the parent entered | Persisted (same as test) |
| Office notifications | List of `notify_emails` recipients | Each gets an email with the responses |
| GHL contact field writes | Every `ghl_writeback` mapping with the value | Written to the parent's GHL contact (no-overwrite) |
| Webhooks / automation triggers | Every `webhook_urls` URL + expandable JSON payload preview | POST to each URL with a 5s timeout |
| Stripe Connect payment | Would-be amount | Stripe Checkout session created on school's account |
| Skipped files | Any file-upload fields that had a file selected | Files uploaded to `portal_form_submission_files` |

**Footer of the result page:**
- **Send notification email to me** — types your email address (default-fills with your session email), click Send → fires the EXACT production notification email body to that address. Verify the rendering, subject line, branded sender, etc. before pushing the form to families.
- **Run another test** — back to the preview with test mode on
- **View raw in inbox** — go straight to the submissions inbox with the test toggle on, so you can see the row that was persisted

**Safety guarantees:**
- Test submissions have NULL `family_id` and NULL `parent_id`. A DB CHECK constraint enforces "either is_test=true OR both are set" — you cannot accidentally write a real submission without a family.
- The result page redirects away if a non-test submission id is passed, so a real parent's submission can never be viewed through the test result UI.
- The submissions inbox HIDES test rows by default. You have to click "Show tests (N)" to see them.
- **"Clear all tests"** button on the inbox (visible only when tests are showing) hard-deletes only `is_test=true` rows. Real submissions are never touched.

**[INTERNAL]**

- Column: `is_test boolean NOT NULL DEFAULT false` on `portal_form_submissions` (migration 040). Index on `(form_definition_id, is_test)`. Family/parent nullability + CHECK from migration 041.
- Pages: `/school/[locationId]/forms/[formId]/preview` (toggle on `?test=1`), `/school/[locationId]/forms/[formId]/preview/result?submission=<id>` (result page).
- Endpoints: `POST /api/admin/schools/[schoolId]/forms/[formId]/test-submit` (persist test row), `/test-submit/send-email` (fire real email of a test submission to a chosen address), `/test-submit/clear` (bulk delete test rows for a form).
- Client: `TestSubmitForm.tsx` (interactive renderer — mirrors `FormPreviewRenderer.tsx` but with enabled inputs), `SendTestEmailButton.tsx`.
- File uploads in test mode are NOT persisted — listed in the result page as "skipped files" so staff knows what would have happened.
- Per-student forms in test mode hardcode `student_id=__test__` and use placeholder "Charlie Sample"/"Sam Sample" labels in the picker.

## Submissions inbox

**[EXTERNAL]**

Where: **Payments → Forms tab → click any form → View submissions**.

Two sections:
1. **Submitted** — every family that has submitted, with row expand for full response detail. Each row shows family, student (if per-student), parent email, status pill, submitted timestamp.
2. **Not yet submitted** — every eligible family/student pair that hasn't submitted yet, with their primary parent's email and phone for follow-up.

A progress bar at the top shows your completion %. Real submissions only — test submissions don't inflate the rate.

**Header buttons:**
- **Show tests (N)** — surfaces test submissions with a green `TEST` badge per row. Click again to hide.
- **Clear all tests** — appears only when tests are showing. Hard-deletes only test rows. Real submissions never touched.
- **Edit form** — back to the editor.

**[INTERNAL]** Page: `/school/[locationId]/forms/[formId]/submissions`. Test inclusion via `?show_test=1` (default off). Uses LEFT JOINs on families/parents/students so test rows (NULL family_id) still appear when included.

---

# End-to-end flows

## Flow 1 — New school onboarding

1. Operator provisions the school: row in `schools`, dashboards enabled, GHL location id linked.
2. Operator configures **tuition grids** (programs × prices) for the upcoming academic year via `/admin/[schoolId]/payments`.
3. School connects Stripe Connect via **Payments → Settings → Connect with Stripe**. Onboarding pill goes Live.
4. School (or operator) seeds **payment plan templates** via the school-side Plans tab. Optionally clicks "Seed 4 default plans" for the common shapes.
5. School configures any **products** they want to sell (registration fees, optional add-ons) via the Catalog tab.
6. School configures **forms** (enrollment, medical, permission) via the Forms tab. For each, sets `notify_emails`, `confirmation_message`, optional `confirmation_redirect_url`, optional `webhook_urls`.
7. School runs **Test mode** on every form to verify the parent experience + downstream effects.
8. School sends parents the enrollment-portal link.

## Flow 2 — Parent enrolls

1. Parent clicks the magic link from staff (or signs in to the portal directly).
2. Lands on `/home`, sees pending forms banner.
3. Fills out enrollment form. Submits.
4. Parent-portal `/api/portal-forms/submit` handler runs:
   - Validates schema
   - Inserts `portal_form_submissions` row
   - Stores file uploads
   - Audit log
   - GHL writeback (no-overwrite)
   - PDF receipt email if enrollment-type
   - Admin-change notification if parent info differs from file
   - **Office notification emails** to every `notify_emails` address
   - **Webhook fan-out** to every `webhook_urls` entry
5. Parent redirected to `/forms-v2/thanks/[submission_id]` which renders the school's `confirmation_message` and auto-redirects to `confirmation_redirect_url` if set.
6. If the form has `payment_config` / `fee_amount`, parent is detoured through `/billing/pay/<invoice>` first, then lands on the thanks page after payment.

## Flow 3 — Parent picks a tuition plan

1. Parent visits `/tuition` in the portal (or follows the magic link).
2. Tuition Plan Picker shows every active plan template with live per-installment math (uses the family's tuition grid for amounts).
3. Parent picks a plan. Endpoint at `/api/tuition/enrollment/[enrollmentId]/select-plan` creates the `family_tuition_enrollments` row, generates all installment invoices via `lib/billing/tuition-plan-generator.ts`.
4. Parent sees their new plan + first installment due date. Can opt into autopay (saves a payment method via Stripe Setup Intent on the school's Connect account).
5. Each invoice's due date triggers autopay (if enabled) via the daily cron, charging via Stripe Connect on the school's account. Webhook updates `invoices.amount_paid_cents`, etc.

## Flow 4 — School edits a struggling family's plan

1. School staff opens **Payments → Tuition Plans → click the family row**.
2. On the plan detail page, clicks **Reschedule remaining balance**.
3. Picks new count (e.g. 15) + start date + cadence.
4. System voids all open invoices, computes the new spread from the outstanding balance, creates new invoices.
5. Parent's portal updates immediately. Autopay continues against the new invoices if they had it enabled.

---

# Migrations index

| # | Filename | What it adds |
|---|---|---|
| 016 | `payments_phase1.sql` | `tuition_grids`, `payment_plans`, `school_payment_config`, `school_payment_accounts`. The original payments schema. |
| 017 | — | (numbering skip; check git log) |
| 018 | `invoices_and_payments.sql` | `invoices`, `invoice_line_items`, `invoice_payments`. |
| 019 | `autopay.sql` | Autopay columns on invoices + parent payment methods. |
| 020 | `form_payments.sql` | `payment_config` jsonb on `portal_form_definitions`. |
| 022 | `tuition_enrollments.sql` | `family_tuition_enrollments`. |
| 036 | `payment_fees.sql` | `plan_change_fee_cents`, `withdrawal_fee_cents`, etc. on `school_payment_config`. |
| 037 | `school_products.sql` | `school_products` + `product_purchases` tables. |
| 038 | `facts_imports.sql` | `school_facts_import_mappings` + `school_facts_imports`. |
| 039 | `payment_plan_start_date.sql` | `first_due_month_day text` on `payment_plans` with CHECK constraint. |
| 040 | `form_test_mode.sql` | `is_test bool` on submissions; `confirmation_message`, `confirmation_redirect_url`, `notify_emails text[]` on form defs. |
| 041 | `form_test_nullable_family.sql` | Drops NOT NULL on `family_id`/`parent_id` of `portal_form_submissions`, adds CHECK that real subs still require both. |
| 042 | `form_webhooks.sql` | `webhook_urls text[]` on `portal_form_definitions`. |

Run with `node scripts/migrate.mjs`. The runner skips already-applied migrations (tracked in `_migrations`).

---

# Env vars

**Required to take real money:**

| Var | Where | What it does |
|---|---|---|
| `STRIPE_SECRET_KEY` | both repos | Stripe API key (use `sk_live_*` in production, `sk_test_*` for testing). |
| `STRIPE_WEBHOOK_SECRET` | parent-portal | Verifies signature on incoming Stripe webhook events. |
| `STRIPE_CONNECT_CLIENT_ID` | dashboards | OAuth client id for Connect onboarding. |
| `STRIPE_APPLICATION_FEE_CENTS` | parent-portal | Platform fee routed to us per charge (currently $25 for tuition / setup fees). |

**Required for forms post-submit effects:**

| Var | Where | What it does |
|---|---|---|
| `RESEND_API_KEY` | both repos | Sends office notification emails + send-test-email-to-me. Without it, sends are logged as `console.warn` (no error). |

**Required for GHL integration:**

| Var | Where | What it does |
|---|---|---|
| `GHL_LOGIN_SECRET` | dashboards | Shared secret for verifying the JWT GHL signs on Custom Menu Link clicks. |
| `SCHOOL_SESSION_SECRET` | dashboards | Signs our minted school-session JWT (base64-decoded as HMAC key). |
| `SESSION_SECRET` | dashboards | HMAC for the operator session cookie. |
| `GHL_API_KEY` | parent-portal | For contact-record reads + writebacks (per-school sub-account key). |
| `CRM_APP_BASE` | both repos | Defaults to `https://app.gohighlevel.com`. Used to build "Open in GHL" deep links. |

**Optional knobs:**

| Var | Default | What it does |
|---|---|---|
| `PARENT_PORTAL_BASE_URL` | `https://growth-suite-parent-portal.vercel.app` | Used to build public product pay links + forms-v2 redirects. |
| `DEV_AUTH_BYPASS` | `false` | When `true` + `NODE_ENV !== production`, allows `?dev_token=<INTERNAL_API_TOKEN>` to stand in for a GHL JWT on `/school/*` routes. Audited via `widget_fetch_log`. |
| `INTERNAL_API_TOKEN` | — | Used by the dev bypass above + by internal cron callers. |

---

# Operator playbook — common tasks

### Add a new payment plan template
School view → Payments → Tuition Plans → "Add a new payment plan template" (collapsible at bottom of templates section). Pick installment count + optional first-due date + optional discount %. Done.

### Spread a family's remaining balance over more months
School view → Payments → Tuition Plans → click the family row → "Reschedule remaining balance" → pick new count + start date + cadence → Apply.

### Test that a form works end-to-end before sending to families
School view → Payments → Forms → click form → Preview layout → "Enter test mode" → fill + Submit test. Review the result page top half (what parents see) and bottom half (what would have happened). Click "Send notification email to me" to verify the office email body looks right.

### Add a Zapier/Make/GHL automation trigger to a form
School view → Payments → Forms → click form → "After a parent submits" section → paste the webhook URL into "Webhook URLs / automation triggers" (one per line). Save. Test it via test mode (the dry-run report shows the JSON payload preview). Once production has fired one real submission, double-check it landed in your automation tool.

### Bill a family for a one-off charge
School view → Payments → Invoices → "Create invoice" → pick family → use the **"Add from catalog"** dropdown to pick a product or tuition grid (auto-fills description + amount). Or use "Add custom line" for a one-off. Set due date. Send.

### Refund a product purchase
Operator only today: `/admin/[schoolId]/payments/purchases` → click the purchase → Refund button. Picks the right Stripe refund flow based on the original charge.

### Clean up test submissions
School view → Payments → Forms → click form → View submissions → "Show tests (N)" → "Clear all tests". Real submissions are never touched.

### Set the first payment due date for a plan
School view → Payments → Tuition Plans → click Edit on the template row → "First payment due (optional)" → pick any date (only month + day are stored; year is auto-derived from each family's academic year).

---

# Troubleshooting

### "This page couldn't load. A server error occurred."
A server-side render threw. Most common cause: a server component is passing an event handler (`onClick`, `onSubmit`, etc.) to a DOM element. In Next.js 16 server components, those throw `Event handlers cannot be passed to Client Component props`. Move the component to a client component (`'use client'` at the top) or convert the wrapper to a non-form element.

### Parent gets a login screen when staff click "Preview layout"
The button must point at `/school/[locationId]/forms/[formId]/preview?chrome=none` — NOT at `${PARENT_PORTAL_BASE}/forms-v2/<slug>`. The parent-portal URL requires a parent session and forces a login. Both the Forms tab and the form editor's "Preview layout" buttons point at the in-iframe preview as of commit `1a72328`.

### Webhook never fires
1. Confirm the URL is `https://` (the API rejects everything else).
2. Confirm at least one REAL (non-test) submission has come in since the URL was added. Test submissions never fire webhooks.
3. Check Vercel logs for `[webhook]` warnings — non-2xx responses and timeouts are logged but don't bubble up.
4. Test the URL with curl: `curl -X POST -H 'Content-Type: application/json' -d '{}' <url>`. If it 404s or returns >2xx, your webhook target has a problem, not ours.

### Office notification email never arrives
1. Check `RESEND_API_KEY` is set in the parent-portal Vercel env. Without it sends are no-ops (logged as `console.warn`).
2. Confirm the address survived the API regex: `^[^\s@]+@[^\s@]+\.[^\s@]+$` (no whitespace, has `@`, has `.` after).
3. Use the test result page's **"Send notification email to me"** button to verify the email pipeline + template — that bypasses the form's notify list and sends to the address you type.

### Test submission failed with `portal_form_submissions_real_has_family_parent`
You're trying to insert a row with NULL family/parent but `is_test=false`. Either set `is_test=true` (this is what the test-submit endpoint does) or supply both family_id and parent_id.

### Stripe Connect pill stays "Onboarding" forever
Stripe is waiting for additional info. Click the pill → "Resolve in Stripe" → finish the requirements in the Stripe dashboard. State syncs back on the next Settings page load.

### Family's tuition plan shows wrong amounts
The grid amount has changed since the family enrolled, but the `family_tuition_enrollments` row snapshots the amount at enrollment time. The displayed annual total is the snapshot. To re-snap: either edit the enrollment to point at the same grid (which re-runs the generator) or delete + recreate via the plan-picker flow.

### "Preview as parent" / "live ↗" buttons on the operator forms list
Those intentionally point at the parent-portal URL and require parent login — they're for end-to-end testing with Michelle (the seeded DGM test parent: `michellelynnpt@gmail.com` / `dgm-demo-2026`). Staff testing should use the in-iframe preview's Test mode instead — same data, no parent login needed.

---

## Recent changelog (most recent commits relevant to this doc)

- `64f5102` Form post-submit effects: webhooks + send-test-email-to-me
- `fcf0e33` (parent-portal) Forms: post-submit office notifications + webhook fan-out + thanks page
- `d93b518` Form preview: fully functional Test mode + dry-run report
- `50f2c95` Fix form preview 500: remove server-side onSubmit handler
- `1a72328` Form preview: open inside iframe, demote test-parent link
- `61b7c99` Form preview: stay in school iframe, no parent login required
- `d8a01db` Invoice creation: catalog dropdown for products + tuition plans
- `47dea2e` Payment plan templates: school-configurable first-due-date anchor
- `526324f` Plan template Edit button + full per-family plan editing confirmed
- `069d75c` School-side plan template CRUD in Tuition Plans tab
- `744ba7e` School-side products + Catalog tab + Settings iframe-escape fix

When you change anything material above, append the new commit and bump the migration index.
