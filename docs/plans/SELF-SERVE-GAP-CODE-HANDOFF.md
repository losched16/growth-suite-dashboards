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

**Verification done in the cloud session (all three features):**
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

4. **Financial-aid settings as a school-facing tab.** FA award settings +
   FA→discount are operator-only (`app/admin/[schoolId]/financial-aid/*`); no
   school tab, and award→discount is a manual conversion. Surface an FA tab in
   the school Payments hub (dual-auth the settings route), optionally
   auto-convert award→discount on approval. *Medium.*

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
