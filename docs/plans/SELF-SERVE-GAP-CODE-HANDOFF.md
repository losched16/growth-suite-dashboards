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

**Verification done in the cloud session:**
- `npx tsc --noEmit` → **0 errors project-wide** (deps installed to check).
- `npx eslint` on both files → clean.

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

## Remaining self-serve gap-code items (ready to build next, not yet done)

Pulled from the two self-serve analyses. Each is small-to-medium and closes a
step that currently forces you into scripts/SQL or the operator console.

1. **Custom domain (`custom_host`) field — portal domains gap.** The portal
   already resolves per-school branding by `school_branding.custom_host`
   (`parent-portal/lib/branding.ts`), but no UI writes it — it's DB-only today.
   Add a `custom_host` text input to the school settings/branding form and
   include the column in the writing route
   (`app/api/school/[locationId]/portal-settings/route.ts` and/or the operator
   `parent-portal-branding` route). *Small.* (Actually attaching the domain in
   Vercel + DNS stays manual unless you wire the Vercel Domains API — separate,
   larger.)

2. **Advanced billing config in the school Settings tab.** Late-fee
   amount/grace and autopay day-of-month are editable only in the `/admin`
   operator console; the school Settings tab round-trips them as hidden inputs
   (`payments/tabs/Settings.tsx`). The save route already accepts them — just
   surface the fields. *Small.*

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
