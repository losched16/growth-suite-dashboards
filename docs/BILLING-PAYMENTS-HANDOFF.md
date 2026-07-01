# Growth Suite — Billing, Payments & Financial Aid
### Engineering Handoff

**Audience:** the incoming dev team taking ownership of everything where **Stripe and money** are involved — tuition management, invoicing, payment collection, autopay, financial aid, and the FACTS bridge.

**Applies to both repos:** `growth-suite-dashboards` (operator/school-facing) and `growth-suite-parent-portal` (parent-facing), which share one database.

**Last updated:** 2026-07-01

---

## 1. What this subsystem is (TL;DR)

Growth Suite is a **multi-tenant, white-labeled SaaS** for private/Montessori schools, layered on top of **GoHighLevel (GHL)** (the CRM/marketing system) and **Supabase Postgres**. Each school is a tenant identified by a `school_id` (and a GHL `location_id`).

The "money side" you're taking over does five things:

1. **Tuition management** — models each family's tuition (a tuition **grid** + a **payment plan** + add-ons + discounts) and generates **invoices**.
2. **Payment collection** — parents pay invoices by card/ACH through **Stripe Connect**. Each school connects *their own* Stripe account; Growth Suite is the **platform**.
3. **Autopay** — charges saved payment methods on a schedule (daily cron).
4. **Financial aid** — a parent application wizard + operator award settings; awards convert into tuition **discounts**.
5. **FACTS bridge** — imports tuition/aid data from **FACTS** (the incumbent tuition system many schools still use in parallel).

> Everything else in the product — GHL contact/roster sync, enrollment forms, the parent-portal shell, notifications — is **not** in your scope. See **§11 (Ownership boundary)** for the exact line.

---

## 2. Architecture at a glance

- **Two Next.js apps, one Postgres database.**
  | Repo | Role | Money surface | Deploy |
  |---|---|---|---|
  | `growth-suite-dashboards` | Operator + school admin | `app/(admin\|school)/[…]/payments/*`, invoice creation, tuition config, FACTS import, FA settings, Stripe Connect onboarding, the Finance Hub widget | growth-suite-dashboards.vercel.app |
  | `growth-suite-parent-portal` | Parent-facing | pay invoices, payment methods, autopay, receipts, FA application | growth-suite-parent-portal.vercel.app + per-school custom domains (e.g. `portal.desertgardenmontessori.org`) |

- **Vercel** for both; **auto-deploy on push to `master`**.
- **Supabase Postgres**, reached via `DATABASE_URL` (transaction-mode pooler, port 6543). Schema is managed by ordered SQL files in `growth-suite-dashboards/migrations/` (NNN_name.sql). Run them in order against the DB; there is no ORM/migration framework — they're plain SQL.
- **Stripe Connect.** Growth Suite is the **platform**; each school onboards a **connected account** via OAuth. Charges are created *on behalf of* the connected account, so **funds settle to the school's Stripe**, not Growth Suite's. Refunds and payouts belong to the school. The platform owns the webhook + orchestration.
- **GHL is the source of truth for contacts/roster** (families, parents, students), synced into Postgres. **Billing is mastered in Growth Suite's DB, NOT in GHL** — tuition/plan/invoice data does not round-trip to GHL, except two read-only writebacks (tuition amount + admission date) noted in §6.

---

## 3. Data model (the money tables)

Exact columns live in `growth-suite-dashboards/migrations/`. The core tables:

- **Tuition config (per school):**
  - `tuition_grids` — a named price grid (e.g. by grade/program). `payment_plans` — installment schedules (monthly / semi-annual / annual, with % modifiers).
  - `discount_rules` / `discounts` — per-school discount definitions (sibling %, prompt-pay %, etc.); financial-aid awards also land here.
- **Per-family enrollment/tuition:**
  - `family_tuition_enrollments` (a.k.a. the enrollment/plan row) — ties a **student × academic_year** to a chosen grid + plan + add-ons + computed totals + due dates. This is the heart of "what does this family owe."
- **Invoicing & payments:**
  - `invoices` + line items — one row per bill; line items carry the breakdown (tuition, fees, add-ons, credits).
  - `payments` — recorded payment attempts/successes (populated by the Stripe webhook).
  - `payment_methods` — saved cards/ACH per family (Stripe payment method ids + a default flag).
  - `products` + `purchases` — one-off sellable items and their purchase/subscription records (incl. refunds, cancellations).
- **Stripe links:**
  - The school's **connected account** state (charges_enabled / payouts_enabled / requirements / live-vs-test) lives on the school record; **Stripe customer** ids link families to the connected account.
- **Financial aid:**
  - FA **application** rows + draft state, uploaded **documents**, and per-school FA **settings** (worksheet config, award rules). Awards feed `discounts`.
- **Idempotency/audit:** the Stripe webhook logs raw events before processing (dedupe by event id).

> ⚠️ Confirm exact table/column names in `migrations/` before writing queries — this section is the conceptual map, not the DDL.

---

## 4. Stripe integration

**Model: Stripe Connect, platform + connected accounts.**

- **Onboarding (dashboards):** `lib/stripe/connect-oauth.ts`, `lib/stripe/connect-onboarding.ts`, and the routes under `app/api/admin/schools/[schoolId]/payments/connect*`. A school clicks "connect Stripe," runs the OAuth flow, and their connected-account id is stored on the school. `refresh-account` re-pulls account state.
- **Clients:** `lib/stripe/client.ts` in **both** repos (initializes the Stripe SDK with the platform secret key). Parent-portal `lib/stripe/customer.ts` manages per-family Stripe customers + payment methods on the connected account.
- **Charging:** payment intents are created **on behalf of the connected account** (parent pays → funds to school). See the parent `billing/pay/[invoiceId]` flow and `lib/billing/autopay-charge.ts`.
- **Webhook:** `growth-suite-parent-portal/app/api/webhooks/stripe/route.ts`. Verifies signature against `STRIPE_WEBHOOK_SECRET` (platform) / `STRIPE_CONNECT_WEBHOOK_SECRET` (connected-account events). Handles:
  - `account.updated`, `account.application.deauthorized` → mirror connected-account state / disable charging on deauth
  - `payment_intent.succeeded` → record payment success
  - `payment_intent.payment_failed` → record failure (retry scheduler)
  - `charge.refunded` → record refund
  - `checkout.session.completed`, `invoice.paid`, `customer.subscription.deleted`
  - `payment_method.attached` / `payment_method.detached`
  - Raw events are logged first; unknown types are no-ops (always returns 2xx so Stripe stops retrying).
- **Test vs live:** connected accounts carry a live/test flag; there's an operator toggle + a `test-receipt-webhook` route for exercising the receipt path.

---

## 5. Money flows (end to end)

1. **School → Stripe onboarding.** Operator connects the school's Stripe (OAuth) → connected-account id + capabilities stored → `account.updated` webhook keeps state fresh → school can now be charged into.
2. **Set up tuition.** Operator builds `tuition_grids` + `payment_plans` + `discount_rules` (dashboards `payments` tabs: Grids, Discounts, Plans). Optionally **import from FACTS** (`lib/billing/facts-import.ts`, `facts-bulk.ts`) or bulk-set tuition.
3. **Enroll a family.** Enrollment/plan selection creates a `family_tuition_enrollments` row (student × year × grid × plan × add-ons). `lib/billing/tuition-plan-generator.ts` + `fee-math.ts` compute totals, proration, and due dates. Parents can self-serve "change plan" (`app/(portal)/tuition`).
4. **Generate invoices.** `lib/billing/create-enrollment-invoices.ts` (portal) / the admin invoice creators produce `invoices` + line items. Emails via `lib/billing/send-invoice-email.ts`.
5. **Parent pays.** `app/(portal)/billing/pay/[invoiceId]` + `PaymentForm.tsx` → Stripe payment intent on the connected account → `payment_intent.succeeded` webhook → `payments` row + invoice marked paid → receipt (`lib/billing/ghl-receipt.ts`, `enrollment-receipt-pdf.ts`, `send-payment-email.ts`).
6. **Autopay.** Cron `POST /api/cron/process-autopay` (parent-portal, **daily 14:00 UTC**) finds due invoices for families with a saved card + autopay enabled and charges them (`lib/billing/autopay-charge.ts`, `oneoff-autopay.ts` for one-off invoices).
7. **Financial aid.** Parent completes the wizard (`app/(portal)/financial-aid/apply`, schema in `lib/financial-aid/wizard-schema.ts`, docs in `document-catalog.ts`) → operator reviews in `financial-aid/settings` → award converts to a discount (`fa-to-discount` route) → reduces the family's tuition.
8. **Products / purchases / refunds.** Operator defines `products`; parents buy (`app/(portal)/products`, subscriptions under `billing/subscriptions`); refunds via `payments/purchases/[id]/RefundForm.tsx`.

---

## 6. Module map (where to start reading)

**Shared billing engine — `growth-suite-*/lib/billing/`:**
- `fee-math.ts` — money math + `fmtCents` formatting (used everywhere).
- `create-enrollment-invoices.ts`, `create-form-invoice.ts` — invoice generation.
- `tuition-plan-generator.ts`, `parent-preview.ts` — build/preview a family's plan.
- `discounts.ts`, `billing-shares.ts` — discounts + divorced-family cost splitting.
- `autopay-charge.ts`, `oneoff-autopay.ts` — autopay charging.
- `facts-import.ts`, `facts-bulk.ts` — FACTS ingestion.
- `invoice-catalog.ts` — reusable line-item catalog.
- `send-invoice-email.ts`, `send-payment-email.ts`, `ghl-receipt.ts`, `enrollment-receipt-pdf.ts`, `admin-change-notification.ts` — comms/receipts.
- `tuition-ghl-writeback.ts`, `admission-date-ghl-writeback.ts` — the *only* two writebacks to GHL (read-only mirrors).

**Stripe — `growth-suite-*/lib/stripe/`:** `client.ts` (both), `connect-oauth.ts`, `connect-onboarding.ts` (dashboards), `customer.ts` (portal).

**Financial aid — `lib/financial-aid/`:** `wizard-schema.ts`, `document-catalog.ts`, `settings.ts` (both repos).

**Operator UI — `growth-suite-dashboards/app/(admin|school)/[…]/payments/*`:** invoices (create/void/send/autopay/bulk), products, purchases, plans, grids, discounts, facts-import, bulk-tuition, connect. (`admin/*` = internal operator; `school/*` = the same surface embedded in GHL for the school.)

**Parent UI — `growth-suite-parent-portal/app/(portal)/`:** `billing/*` (pay, subscriptions, payment-methods, year-end-statement), `tuition/*`, `products/*`, `financial-aid/*`.

---

## 7. Entry points

- **Stripe webhook:** `parent-portal /api/webhooks/stripe` (see §4).
- **Crons:**
  - `parent-portal /api/cron/process-autopay` — daily 14:00 UTC (autopay).
  - `dashboards /api/cron/sync-all` — every 15 min (GHL roster sync; **not yours**, but it feeds the roster billing reads).
- **Key API routes:** `dashboards /api/admin/schools/[schoolId]/payments/*` (invoices, plans, grids, discounts, connect, config, enrollments, bulk-facts-tuition), `/api/school/billing/go-live`; `parent-portal /api/billing/*` (payment-methods, subscriptions), `/api/tuition/enrollment/[id]/select-plan`, `/api/financial-aid/*`.

---

## 8. Secrets & environment variables

Set in **Vercel** per project (dashboards + parent-portal). Money-relevant:

- **Stripe:** `STRIPE_SECRET_KEY` (platform), `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET`, `STRIPE_CLIENT_ID` (Connect OAuth), publishable key for the client. (Confirm exact names in the two `lib/stripe/client.ts` + the webhook route.)
- **Database:** `DATABASE_URL` (Supabase transaction pooler).
- **Email:** `RESEND_API_KEY`, `RESEND_FROM_ADDRESS`, `RESEND_REPLY_TO` (Resend; some schools route email through GHL instead — see `lib/email.ts`).
- **Cron auth:** `CRON_SECRET` / `INTERNAL_API_TOKEN` (Bearer auth on cron endpoints).
- **GHL:** per-school OAuth token (encrypted in DB) + `GHL_WEBHOOK_SECRET` — only relevant to you for the two writebacks.

---

## 9. External integrations

| System | Role | Where |
|---|---|---|
| **Stripe (Connect)** | Payment processing; each school's own account | `lib/stripe/*`, webhook |
| **FACTS** | Incumbent tuition system; import source | `lib/billing/facts-*` |
| **GHL** | Contacts/roster (source of truth) + 2 writebacks | sync layer (not yours) + `lib/billing/*-ghl-writeback.ts` |
| **Resend** | Transactional email (invoices, receipts) | `lib/email.ts`, `lib/billing/send-*` |
| **Supabase Postgres** | Single shared DB | `lib/db.ts` (both repos) |

---

## 10. Local dev, migrations, deploy, testing

- **Run:** each repo is a standard Next.js app (`npm install`, `npm run dev`). Both need `.env.local` with at least `DATABASE_URL` + the Stripe keys to exercise money paths.
- **Migrations:** apply `growth-suite-dashboards/migrations/NNN_*.sql` in order against Postgres (plain SQL; no framework). New migration = next number; **watch for number collisions** if multiple people add migrations.
- **Deploy:** push to `master` → Vercel auto-deploys both. DB/config changes are live immediately (shared DB).
- **Stripe testing:** use test-mode connected accounts + the Stripe CLI to replay webhook events at the webhook route; `test-receipt-webhook` exercises the receipt path.

---

## 11. Ownership boundary (what's yours vs what stays)

**Yours (money):**
- `lib/billing/*`, `lib/stripe/*`, `lib/financial-aid/*` (both repos)
- `app/(admin|school)/[…]/payments/*` (dashboards) and `app/(portal)/{billing,tuition,products,financial-aid}/*` (parent-portal)
- `app/api/**/payments/*`, `app/api/billing/*`, `app/api/tuition/*`, `app/api/financial-aid/*`
- `app/api/webhooks/stripe`, `app/api/cron/process-autopay`
- The money tables (§3) + their migrations

**Not yours (stays with the platform team):**
- GHL sync (`lib/sync/*`), the family/parent/student roster (read-only inputs to billing)
- Enrollment forms & the form renderer (`app/(portal)/forms-v2/*`) — *except* where a form triggers `create-enrollment-invoices` (that boundary is the invoice call)
- Portal auth/shell, notifications, the GHL contact webhooks

**Shared seams to coordinate on:** the enrollment form's `payment_config` (drives what invoices get created), the two GHL writebacks, and `lib/db.ts` (shared DB client).

---

## 12. Current state, known gaps & gotchas

- **Billing is display-only for some schools** (e.g. DGM): the enrollment agreement *shows* computed tuition but **FACTS collects the money** — `require_payment_method_on_file=false`, no Stripe charge on submit. Other schools charge through Stripe. This is per-school config, not a global mode.
- **Stripe money settles to the school, not the platform** — plan support/monitoring accordingly.
- **`fee-math.fmtCents`** is the single money formatter — use it, don't re-roll currency formatting.
- **Autopay** only runs once/day (14:00 UTC); it's gated on card-on-file + autopay/billing flags per family.
- **Financial aid awards → discounts** is a conversion step (`fa-to-discount`), not automatic on approval.
- **Idempotency:** the Stripe webhook dedupes on event id + always returns 2xx; keep that contract when adding handlers.

---

## 13. Access checklist (to grant the dev team)

- [ ] **GitHub:** both repos (`growth-suite-dashboards`, `growth-suite-parent-portal`).
- [ ] **Stripe:** platform account (Connect settings, webhooks, API keys) + a way to view/test connected accounts.
- [ ] **Vercel:** both projects (env vars, deploy logs, cron logs).
- [ ] **Supabase:** DB access (read at minimum; write for migrations) + connection string.
- [ ] **Resend:** if they'll touch receipt/invoice email.
- [ ] **FACTS:** credentials/exports if they'll work on the import.
- [ ] **Env vars:** hand off the Stripe/DB/Resend/cron secrets (§8) securely.
- [ ] **GHL:** read-only context only (they need to understand the roster inputs + the 2 writebacks, not own GHL).

---

*Questions this handoff should prompt back from the dev team:* which schools are live-charging vs FACTS-only today; whether they want to consolidate the two `lib/stripe/client.ts` copies; and how they want to own migrations given the shared-DB, shared-migrations-folder setup.
