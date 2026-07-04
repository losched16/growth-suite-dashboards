# School Onboarding Portal — Architecture Plan

*Planning doc (cloud session — no build yet). Decision: **lean custom tracker +
GHL for comms**, **school-facing first** with an ops rollup. This spec is
grounded in existing building blocks so most of it is assembly, not new
invention.*

## The idea in one paragraph

A guided onboarding experience where a new school logs in (before they're even a
full tenant), sees a **checklist of what's done / pending / needs-them**,
**submits their setup documents** (roster CSV, rate card, logo, etc.), reads
**step-by-step instructions**, and gets **automated reminders** about what's
outstanding. The truth of "done vs pending" is **derived from real system
state** in your DB (not self-reported), and GHL is the engine that sends the
nudges. It's essentially a friendly wrapper + tracker over the self-serve
capabilities already built (settings, dashboards, forms, tuition, Stripe,
go-live).

## Division of labor (why this beats either extreme)

- **GHL client portal alone can't do this** — it has no window into your
  Supabase state (roster synced? Stripe connected? tuition live?), so it could
  only show self-reported status. That's the exact thing you want to track.
- **A full second parent-portal-style build is overkill** — you'd duplicate
  auth/hosting/security for what is a checklist + uploads + instructions.
- **So:** your app owns the *truth* (derived status) and the *checklist UI*;
  GHL owns *comms* (reminders, email/SMS) and the *pipeline* view for your
  sales/ops motion. They sync via a status writeback you already know how to do.

## What we reuse (most of the plumbing exists)

| Need | Reuse |
|---|---|
| Per-school real-status derivation | `app/admin/billing-status/page.tsx` already derives Stripe/enrollments/invoices/billing_active per school — extend its queries to all onboarding steps |
| Document upload storage | `school_documents` (migration 049) — bytea-in-row pattern; add a school→us intake variant |
| Pre-tenant auth (login before they're a tenant) | `lib/auth/staff-magic-link.ts` — signed, single-use, 15-min links emailed via Resend |
| Post-provision auth | existing embedded school shell (`/school/[locationId]/*`) |
| Instructions content | `docs/SCHOOL_ONBOARDING.md` is already the operator playbook — repurpose per-step copy for schools |
| GHL writeback | existing writeback patterns (`lib/billing/*-ghl-writeback.ts`) |
| Reminders / scheduling | GHL workflows (you already use pipelines + workflows) |
| Branded email | `lib/email.ts` `sendBrandedEmail` |

## Data model (new)

Chicken-and-egg to design around: a school onboards **before** a `schools` row
exists (Phase 1 creates it). So the onboarding record keys on the **lead**, and
links to `school_id` once provisioned.

- **`school_onboarding`** — one row per prospective/active onboarding:
  `id`, `ghl_contact_id` (the lead), `ghl_location_id` (once known),
  `school_id` (NULL until provisioned), `school_name`, `contact_name`,
  `contact_email`, `stage` (denormalized from derivation for GHL sync),
  `target_go_live`, `assigned_ops_email`, `notes`, `created_at`, `updated_at`.
- **`onboarding_task_state`** — state for the *non-derived* tasks only
  (document submissions, manual acknowledgements, operator sign-offs):
  `onboarding_id`, `task_key`, `status` (`pending`|`submitted`|`approved`|`rejected`|`skipped`),
  `submitted_at`, `reviewed_by_email`, `review_note`, `updated_at`.
  Derived tasks (school created, roster imported, Stripe connected, tuition set,
  live) need **no rows** — they're computed live.
- **`onboarding_documents`** — school-uploaded intake files (mirror
  `school_documents`): `onboarding_id`, `task_key`, `title`, `original_filename`,
  `mime_type`, `size_bytes`, `contents` (bytea), `status`
  (`uploaded`|`accepted`|`rejected`), `uploaded_at`, `reviewed_by_email`.
  Access-controlled to that school + operators (roster CSVs contain student PII).

## The task registry (code, like your dashboard/form template registries)

A single source-of-truth list in `lib/onboarding/checklist.ts` defining every
onboarding step. Each task is one of three types:

- **`derived`** — status computed from DB (has a `deriveStatus(ctx)` fn).
  Examples: *Account created* (`schools` row), *Roster imported*
  (`families` count > 0), *Stripe connected* (`payment_accounts.charges_enabled`),
  *Tuition configured* (`tuition_grids` + `payment_plans` exist),
  *Dashboards set up* (`school_dashboards` count), *Forms published*
  (`portal_form_definitions` count), *Billing live* (`billing_active`).
- **`document`** — school uploads a file (roster CSV, rate card, logo, W-9,
  handbook). Status from `onboarding_documents`.
- **`manual`** — a checkbox/acknowledgement (e.g. "watched the setup video",
  "confirmed intake vocabulary") or an operator sign-off. Status from
  `onboarding_task_state`.

Each task also carries: `title`, `instructions` (markdown), `owner`
(`school`|`ops`), `phase` (maps to your 5-phase model), `blockedBy` (task keys),
`ctaHref` (deep-link into the actual self-serve surface that completes it —
e.g. the Stripe connect tab, the tuition Grids tab).

## Status-derivation engine

`lib/onboarding/status.ts` → `computeOnboarding(onboardingId)`: loads the
onboarding row, resolves `school_id` if present, runs each task's
`deriveStatus`/state lookup, applies `blockedBy` gating, and returns the full
checklist with `{ status, completedAt, blocked, ctaHref }` plus an overall
`stage` + `percentComplete`. This is the shared truth used by the school view,
the ops board, and the GHL writeback. Extends the existing billing-status query.

## Surfaces to build

### 1. School-facing onboarding page (BUILD FIRST)
- Route: pre-tenant `/onboarding/[token]` (magic-link auth) → graduates to an
  embedded `/school/[locationId]/onboarding` tab once provisioned.
- Shows: progress bar, the checklist grouped by phase (done ✓ / pending / needs
  you / blocked), per-task instructions (expandable), a **doc-upload** control
  on `document` tasks, and a **"Do it now →"** button on `derived` tasks that
  deep-links into the self-serve surface that completes them.
- Reuses the form/file-upload UI + `sendBrandedEmail` for confirmations.

### 2. Ops onboarding board
- Extend `/admin/billing-status` into `/admin/onboarding`: every prospect/school,
  their stage, `% complete`, days-in-stage, what's blocking, last activity,
  pending doc reviews. Operator can approve/reject submitted docs, mark manual
  sign-offs, and trigger a reminder (fires the GHL workflow).

### 3. GHL integration (the comms engine)
- A **"School Onboarding" pipeline** in the agency location; each
  `school_onboarding` row ↔ an opportunity/contact.
- **Writeback**: a nightly cron (you have cron infra) recomputes every
  onboarding's `stage` + a few custom fields (e.g. `onboarding_percent`,
  `next_action`, `docs_outstanding`) onto the GHL contact.
- **Reminders = GHL workflows** branching on those fields — e.g. "stage = Docs
  Requested AND docs_outstanding > 0 for 5 days → send reminder email/SMS". No
  custom scheduler needed.

## Pre-tenant auth + security notes

- Pre-tenant login = signed single-use link (reuse `staff-magic-link.ts`),
  emailed to `contact_email`. Do **not** reuse the auto-mint-from-locationId
  pattern flagged in `SECURITY-REMEDIATION-PLAN.md`.
- Uploads (roster CSVs = student PII) must be scoped to the owning
  onboarding + operators only; authenticated download, no public paths.
- Keep this surface out of the ungated-`/api/admin` trap — every onboarding
  endpoint authenticates (school token OR operator), same pattern as the FA
  settings route we just dual-authed.

## Build phases (suggested order)

1. **Truth layer** — data model migration + task registry + `computeOnboarding`
   (extends billing-status queries). No UI yet; unit-verifiable.
2. **School-facing page** — checklist + doc upload + instructions + magic-link
   auth. (Chosen "school-facing first".)
3. **Ops board** — extend billing-status; doc review + manual sign-offs.
4. **GHL sync** — pipeline mapping + nightly status writeback + reminder
   workflows.
5. **Content + polish** — per-step instructions (from SCHOOL_ONBOARDING.md),
   email templates, target-go-live tracking, "stuck" highlighting.

## How this ties to the self-serve work already shipped

Every `derived` task's "done" state is literally one of the self-serve features
from this session (settings configured, dashboards added, forms published,
tuition/grids/plans set, Stripe connected, go-live). So the onboarding portal is
the **guided front-door** that walks a school through the self-serve platform
and tracks their progress through it — the capstone that makes "sign up → live"
feel like one flow instead of a pile of separate tabs.
</content>
