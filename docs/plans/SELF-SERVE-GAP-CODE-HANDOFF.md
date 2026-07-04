# Self-Serve Gap Code — Desktop Handoff

*Written in a cloud session (no DB/GHL/Stripe creds, no deploy). Code is on
branch `claude/recent-updates-visibility-rh79by`, committed but NOT deployed.
Desktop session: review, test against a real school, then deploy. This is
gap-filling for the self-serve platform — closing per-school steps that used to
require SQL/scripts.*

## Shipped in this batch

### 1. Grid add-ons are now school-editable (billing gap #1)

**Why:** The self-serve billing audit found the make-or-break path (grids →
plans → enrollments → Stripe → go-live → invoicing) is already self-serve UI
end to end — with ONE hole: `tuition_grids.addons` was hardcoded to `'[]'` in
the save route, so extended-day / hot-lunch / materials-fee line items could
only be added by SQL. The enrollment generator already reads and bills add-ons
(`lib/billing/tuition-plan-generator.ts:69,111`); there was just no way for a
school to define them. This closes that.

**Files changed (2):**
- `app/api/school/tuition-grids/save/route.ts`
  - Added `parseAddons()` + `slugify()` helpers. Add-ons come from fixed form
    slots `addon_label_i` / `addon_amount_i` / `addon_required_i` /
    `addon_key_i` (i = 0..7).
  - `op=add` now persists inline add-ons instead of `'[]'`.
  - New `op=set_addons` (grid `id` + slots) replaces a grid's whole add-on
    array. Scoped to `session.school_id` like every other op here.
  - Shape written matches what the generator expects:
    `[{ key, label, amount_cents, required }]`. `key` is persisted in a hidden
    field so renaming a label later keeps the same key (existing enrollments
    snapshot their add-ons at creation, so edits only affect NEW enrollments).
- `app/school/[locationId]/payments/tabs/Grids.tsx`
  - `GridRow` + SELECT now include `addons`.
  - New "Add-ons" column shows each grid's add-ons (label · $amount · `req`).
  - New per-row **Add-ons (N)** editor (`op=set_addons`) and an optional
    add-ons section on the **Add a new grid** form. Both use the shared
    `AddonEditor` (8 slots, prefilled from existing + 2 spares, server-rendered,
    no client JS — matches the rest of the hub).

**Schema:** none. `tuition_grids.addons jsonb NOT NULL DEFAULT '[]'` has existed
since `migrations/016_payments_phase1.sql:114`. Pure code change.

**What still needs manual testing on desktop (cloud can't run the app):**
1. Open a school's Payments hub → Grids tab. Add a grid with 2 add-ons (one
   marked Required). Confirm they render in the Add-ons column.
2. Edit an existing grid's add-ons via the per-row **Add-ons** popover — add,
   change an amount, blank a row to remove it, save. Confirm the array updates.
3. **The critical end-to-end check:** enroll a family on that grid and confirm
   the add-ons flow into the enrollment/invoice correctly — required add-ons
   force on, optional ones are pickable, and `amount_cents` matches. This
   exercises `tuition-plan-generator.ts`'s add-on path, which is the part the
   cloud session could not run.
4. Confirm existing enrollments created before the edit are unchanged (they
   snapshot add-ons at creation).

### 2. Late fees are now school-editable (billing config gap)

**Why:** The school Payments → Settings tab was round-tripping `late_fee_amount`
and `late_fee_grace_days` as hidden inputs — editable only in the `/admin`
operator console. The parent-portal autopay cron already applies these
(`process-autopay/route.ts:159-183`: charges a flat late fee once, after grace,
when `late_fee_amount_cents > 0`). Now schools set their own.

**File changed (1):** `app/school/[locationId]/payments/tabs/Settings.tsx` — new
"Late fees" group (amount + grace days). The config save route already parsed
these fields, so no route change was needed.

**Deliberately left operator-only:** `autopay_days`. It's persisted but I could
not find it consumed by the charge logic (the cron keys off
`autopay_charge_on`/`due_at`), so I kept it as the hidden round-trip rather than
surface a knob whose effect is unverified. Worth confirming before exposing it.

**Test on desktop:** set a late fee + grace on the school Settings tab, save,
confirm it persists; let (or simulate) the autopay cron apply it to an overdue
invoice.

### 3. Custom portal domain field (portal-domains gap)

**Why:** The parent portal already resolves per-school branding by
`school_branding.custom_host` (`parent-portal/lib/branding.ts:57`), but nothing
in any UI wrote it — it was a DB-only edit. Now schools can set it themselves.

**Files changed (2):**
- `app/school/[locationId]/settings/page.tsx` — a "Custom portal domain" field
  in the Branding section, with helper text making clear DNS/hosting must be
  coordinated first (it's a branding lookup key, not a DNS switch).
- `app/api/school/[locationId]/portal-settings/route.ts` — normalizes the input
  to a bare lowercase hostname (`normalizeHost`), validates the shape, persists
  `custom_host`, and returns a friendly error on the unique-host collision
  (parent-portal migration 009's `lower(custom_host)` unique index → PG 23505).

**Schema:** none in this repo. `custom_host` was added by **parent-portal**
`migrations/009_custom_host.sql` against the shared DB, so the column already
exists in production. (Cross-repo migration reality — flagged so desktop isn't
surprised the column isn't in the dashboards `migrations/` folder.)

**Still manual (separate, larger item):** actually *attaching* the domain in
Vercel + DNS. This field only sets the lookup key; pointing the domain remains
operator/infra work until the Vercel Domains API is wired (see remaining #1).

**Test on desktop:** set a custom_host on a test school, confirm it saves; try
setting the same host on a second school → friendly "already in use" error; hit
the portal on that host (once DNS is pointed) → school branding resolves.

### 4. Financial-aid settings as a school-facing tab (policy self-serve)

**Why:** FA settings were operator-only (`/admin/[schoolId]/financial-aid/settings`).
A school couldn't set its own FA policy — enable/disable, required documents,
award caps, cost-of-living context, decision-letter template, parent intro.
Now they self-serve it from a new **Financial Aid** tab in the Payments hub.

**Files changed / added (3):**
- `app/api/admin/schools/[schoolId]/financial-aid/settings/route.ts` — auth
  changed from operator-only (`requireOperator`) to **dual-auth**
  (`authorizeOperatorOrSchool(schoolId)`) on GET + PUT. Still fully
  authenticated: unauth → 401, a school session for a *different* school →
  403 (`forbidden_cross_school`). The settings only ever affect that school's
  own FA, so there is no cross-tenant exposure.
- `app/school/[locationId]/payments/tabs/FinancialAid.tsx` — new tab that
  **reuses the existing operator `SettingsForm`** client component (no
  duplicated form logic), loading the school's settings + the shared document
  catalog.
- `app/school/[locationId]/payments/page.tsx` — new "Financial Aid" tab wired
  into the hub (`school.name` passed through for the form).

**Schema:** none — `school_financial_aid_settings` already exists (migration 045).

**Security note for review:** this deliberately widens FA settings from
operator-only to school-editable, per the product decision that schools own
their own aid policy. It is NOT a new unauthenticated surface — it swaps one
auth guard (`requireOperator`) for a stricter-scoped one
(`authorizeOperatorOrSchool`), which is exactly the pattern the security
remediation plan wants on every `/api/admin` route. Award *decisions*
(`set-award`) and the FA queue were already school-session-authed; this only
adds the policy/config layer.

**Test on desktop:**
1. In a school's Payments hub, open the **Financial Aid** tab. Toggle
   enabled, set required docs + a max-award cap + intro copy, Save → confirm
   it persists (reload) and the parent portal FA page reflects it.
2. Confirm a school session cannot reach another school's FA settings
   (the route 403s cross-school).
3. Confirm the operator `/admin` FA settings page still works (operator
   branch of the dual-auth).

### 5. FA award → tuition discount auto-conversion (closes the FA loop)

**Why:** Converting an approved FA award into a tuition discount was a manual
operator step (a "Create FA discount" button that POSTed `fa-to-discount`).
Now a school decides an award and the discount is created automatically — no
extra step, and reversing/zeroing an award cleanly removes it.

**Files changed / added (3):**
- `lib/billing/fa-discount.ts` (new) — `syncFaDiscountForApplication(q, schoolId,
  faId)`: the single source of the award→discount mapping. Idempotent and
  reversible — decided + award > 0 creates/updates one active
  `discount_policies` row (`kind='financial_aid'`, keyed to the FA app,
  applied to `['tuition','tuition_addon']`); any other state (declined,
  withdrawn, award zeroed, back to under_review) **deactivates** the policy.
  Takes a `q` so it runs inside a transaction.
- `app/api/school/fa-applications/set-award/route.ts` — calls the sync inside
  the existing award transaction, so the FA decision and its discount are
  always atomic/consistent. This is the auto-conversion.
- `app/api/admin/schools/[schoolId]/payments/fa-to-discount/route.ts` —
  refactored to delegate to the shared helper (removes ~55 lines of duplicated
  upsert logic). Keeps its operator-facing validation/errors; it's now a
  manual re-sync / safety net rather than the primary path.

**Correctness notes for review:**
- The discount evaluator (`lib/billing/discounts.ts`) already loads only
  `is_active = true` policies AND live-checks `fa_applications.status='decided'`
  — so reversal is double-covered (deactivation + live status gate).
- Auto-conversion affects **future** invoice generation only (same as the old
  manual button); it does not retroactively rewrite already-generated invoices.
- **Schema:** none — `discount_policies` already has the `fa_application_id`,
  `kind='financial_aid'` columns this uses (migration 069).

**Minor follow-up (not done):** the FA-Queue "Create FA discount" button
(`FinancialAidQueue/QueueTable.tsx`) still works (idempotent re-sync) but its
copy says "created" even when it's now a re-sync. Worth relabeling to "Re-sync
FA discount" since creation is automatic — cosmetic, low priority.

**Test on desktop:**
1. Decide an FA award for a family → confirm a `financial_aid` discount_policy
   appears automatically (no button click) and future tuition invoices apply it.
2. Change that award amount and re-save → the policy's amount updates.
3. Flip the decision to declined (or zero the award) → the policy deactivates
   and new invoices no longer discount.
4. The manual "Create FA discount" button still returns ok (now a re-sync).

**Verification done in the cloud session (all five features):**
- `npx tsc --noEmit` → **0 errors project-wide** (deps installed to check).
- `npx eslint` on every changed file → clean.

## Remaining self-serve gap-code items (ready to build next, not yet done)

Pulled from the two self-serve analyses. Each is small-to-medium and closes a
step that currently forces you into scripts/SQL or the operator console.

1. **Custom-domain field — DONE (field). Vercel/DNS automation — remaining.**
   The `custom_host` field now ships (see Shipped #3). What's still manual:
   automating the actual domain attachment via the Vercel Domains API +
   surfacing the DNS records for the school to add. *Larger — separate project.*

2. **Advanced billing config — DONE (late fees). `autopay_days` — deferred.**
   Late fees now ship school-side (see Shipped #2). `autopay_days` stays
   operator-only pending confirmation it's actually consumed by the charge
   logic. *Trivial to surface once confirmed.*

3. **Custom installment schedules.** Plans beyond 1/2/4/10/12 punt to "the
   operator console" (`payments/tabs/Plans.tsx`). Add a per-installment
   due-date/amount editor to the plan-template form. *Small–medium.*

4. **FA settings school tab — DONE (Shipped #4). FA→discount — DONE (Shipped #5).**
   The whole FA loop is now self-serve: a school sets its policy, decides
   awards, and the tuition discount is created/updated/removed automatically.

5. **Portal hardcoded academic year (bug).** Two constants bypass
   `settings.academic_year` in the **parent-portal** repo:
   `app/(portal)/tuition/page.tsx:21` and
   `lib/billing/create-enrollment-invoices.ts:45` (both `'2026-27'`). Wire them
   to `loadSchoolSettings().academic_year` so a school on a different year
   doesn't get mismatched rows. *Small.* (Parent-portal repo — needs its own
   branch; this session's branch is dashboards-only.)

6. **"Create missing fields" button on the field-audit page.** The GHL field
   API supports creating custom fields; the audit page
   (`app/admin/[schoolId]/field-audit`) currently only reports gaps. A button
   that provisions the missing kit fields would remove the standalone
   `scripts/provision-field-kit.ts` CLI step from onboarding. *Medium.*

Say the word and I'll implement any of these the same way — coded on the
branch, typecheck-clean, with a test checklist, for you to review and deploy.
</content>
