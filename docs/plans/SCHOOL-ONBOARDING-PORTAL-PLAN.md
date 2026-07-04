# School Onboarding Portal — Architecture Plan

*Planning doc (cloud session — no build yet). Decision: **lean custom tracker +
GHL for comms**, **school-facing first** with an ops rollup. This spec is
grounded in existing building blocks so most of it is assembly, not new
invention.*

## The idea in one paragraph

A guided onboarding experience where a new school logs in (before they're even a
full tenant), sees a **checklist of what's done / pending / needs-them**,
**submits the materials you need to build their software** (roster/import files,
branding assets, intake vocabulary, handbook), reads **step-by-step
instructions**, and gets **automated reminders** about what's outstanding. The
truth of "done vs pending" is **derived from real system state** in your DB (not
self-reported), and GHL is the engine that sends the nudges. It serves two
audiences at once: it collects what a school must submit to get their instance
built, and it gives **your team a live view of what's done vs missing** per
school.

> **Out of scope: billing.** Tuition, Stripe, invoicing, and go-live are handled
> **separately by the partner** and are deliberately NOT part of this portal.
> No task here touches payments. This portal is about getting the school's
> *software* (roster, dashboards, forms, parent portal, branding) stood up.

## Division of labor (why this beats either extreme)

- **GHL client portal alone can't do this** — it has no window into your
  Supabase state (roster synced? field kit provisioned? dashboards built?
  forms published?), so it could only show self-reported status. That's the
  exact thing you and your team want to see truthfully.
- **A full second parent-portal-style build is overkill** — you'd duplicate
  auth/hosting/security for what is a checklist + uploads + instructions.
- **So:** your app owns the *truth* (derived status) and the *checklist UI*;
  GHL owns *comms* (reminders, email/SMS) and the *pipeline* view for your
  sales/ops motion. They sync via a status writeback you already know how to do.

## What we reuse (most of the plumbing exists)

| Need | Reuse |
|---|---|
| Per-school real-status derivation | `app/admin/billing-status/page.tsx` is the *technique* to copy (per-school COUNT/EXISTS subqueries into a status grid) — but this portal derives from **non-billing** signals: field audit, roster sync, dashboards, forms, settings. Build a new `/admin/onboarding` board rather than extending the billing one |
| Field-readiness signal | `lib/onboarding/field-audit.ts` + `app/admin/[schoolId]/field-audit` already grade a location's GHL fields (green/blocking) — a ready-made derived task |
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
  `target_launch_date`, `assigned_ops_email`, `notes`, `created_at`, `updated_at`.
- **`onboarding_task_state`** — state for the *non-derived* tasks only
  (document submissions, manual acknowledgements, operator sign-offs):
  `onboarding_id`, `task_key`, `status` (`pending`|`submitted`|`approved`|`rejected`|`skipped`),
  `submitted_at`, `reviewed_by_email`, `review_note`, `updated_at`.
  Derived tasks (school created, field audit green, roster imported, dashboards
  set up, forms published, branding set) need **no rows** — they're computed live.
- **`onboarding_documents`** — school-uploaded intake files (mirror
  `school_documents`): `onboarding_id`, `task_key`, `title`, `original_filename`,
  `mime_type`, `size_bytes`, `contents` (bytea), `status`
  (`uploaded`|`accepted`|`rejected`), `uploaded_at`, `reviewed_by_email`.
  Access-controlled to that school + operators (roster CSVs contain student PII).

## The task registry (code, like your dashboard/form template registries)

A single source-of-truth list in `lib/onboarding/checklist.ts` defining every
onboarding step. Each task is one of three types:

- **`derived`** — status computed from DB (has a `deriveStatus(ctx)` fn).
  Examples (all NON-billing): *Account created* (`schools` row exists),
  *GHL fields provisioned / audit green* (`lib/onboarding/field-audit.ts`),
  *Roster imported* (`families`/`students` count > 0), *Dashboards set up*
  (`school_dashboards` count > 0), *Forms published*
  (`portal_form_definitions` where published), *Branding set*
  (`school_branding` has logo/colors), *Parent portal configured*
  (`schools.settings` academic_year + gate set).
- **`document`** — school uploads a file: roster/import file, logo + brand
  colors, intake vocabulary sheet (grade levels / programs / classrooms),
  parent handbook, calendar. Status from `onboarding_documents`.
- **`manual`** — a checkbox/acknowledgement (e.g. "watched the setup walkthrough",
  "confirmed intake vocabulary is correct", "reviewed the built dashboards") or
  an **operator sign-off** (e.g. ops marks "roster reviewed & imported"). Status
  from `onboarding_task_state`.

Each task also carries: `title`, `instructions` (markdown), `owner`
(`school`|`ops`), `phase`, `blockedBy` (task keys), `ctaHref` (deep-link into
the surface that completes it — e.g. the field-audit page, the dashboard
template gallery, the form builder, the portal settings page).

## Status-derivation engine

`lib/onboarding/status.ts` → `computeOnboarding(onboardingId)`: loads the
onboarding row, resolves `school_id` if present, runs each task's
`deriveStatus`/state lookup, applies `blockedBy` gating, and returns the full
checklist with `{ status, completedAt, blocked, ctaHref }` plus an overall
`stage` + `percentComplete`. This is the shared truth used by the school view,
the ops board, and the GHL writeback. Uses the same per-school COUNT/EXISTS
technique as the billing-status page, but over the non-billing setup signals.

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
- A new `/admin/onboarding` board (same grid technique as billing-status, but
  non-billing signals): every prospect/school, `% complete`, days-in-stage,
  what's blocking, last activity, pending doc reviews. Your team can
  approve/reject submitted docs, mark manual sign-offs, and trigger a reminder
  (fires the GHL workflow). This is the "what's done vs missing" view for the team.

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

## Build status

**Phase 1 foundation — BUILT (on branch, typecheck+eslint-clean, not deployed):**
- `migrations/072_school_onboarding.sql` — `school_onboarding`,
  `onboarding_task_state`, `onboarding_documents`.
- `lib/onboarding/checklist.ts` — the task registry with the four task types,
  including the **`intake`** type (grade levels / programs / schedules /
  classrooms as option-list vocabularies). Sensible starter set; edit freely.
- `lib/onboarding/status.ts` — `computeOnboarding()` status engine (derived +
  stored state → resolved checklist + stage + percent).
- `lib/onboarding/apply-intake.ts` — pushes submitted intake vocabularies into
  the GHL sub-account (PUT customField options across student slots). Reuses
  `loadGhlClient`. **⚠️ live GHL write — must be tested on the desktop against a
  real sub-account before trusting; apply BEFORE roster import.**

**Phase 2 — school-facing slice BUILT (typecheck+eslint-clean, not deployed):**
- `lib/onboarding/token.ts` — pre-tenant HMAC access token
  (`ONBOARDING_TOKEN_SECRET`, falls back to `SESSION_SECRET`; 30-day TTL).
- `app/onboarding/[token]/page.tsx` — the school-facing checklist: progress bar,
  tasks grouped by phase, with per-type controls (intake textarea, file upload,
  manual check-off). Token-authed, no login, server-rendered plain forms.
- `app/api/onboarding/{submit-intake,upload-doc,toggle-manual}/route.ts` — the
  school actions, all token-authed. Uploads → `onboarding_documents` (bytea).
- These routes are NOT proxy-gated (they're pre-tenant) — they self-auth via
  the signed token, following the security-plan lesson (no auto-mint).

**Phase 3 — ops board BUILT (typecheck+eslint-clean, not deployed):**
- `app/admin/onboarding/page.tsx` — cross-school board: live progress, stage,
  pending-doc counts, lead-vs-linked, + a "start onboarding" form. Operator-only.
- `app/admin/onboarding/[id]/page.tsx` — detail: the shareable link (minted),
  editable meta (link `school_id`, target date, assignee, notes), the full
  checklist with submitted intake values + submitted docs, and the **Apply
  intake to GHL** button.
- `app/api/admin/onboarding/create` + `[id]/update` (meta / ops sign-off) +
  `[id]/review-doc` (accept/reject) + `[id]/apply-intake` (calls `applyAllIntake`)
  + `doc/[docId]` (authenticated download). Every route self-authenticates on
  the operator session (the `/api/admin` proxy gap — security-plan lesson).

**Now testable end-to-end (once deployed + `ONBOARDING_TOKEN_SECRET` set):**
operator creates an onboarding at `/admin/onboarding` → copies the link → school
opens it, submits intake + uploads docs → operator reviews docs and clicks
Apply-to-GHL. The only piece needing a live sub-account to verify is the GHL
push itself.

**Phase 4 — email + automated reminders BUILT (typecheck+eslint-clean, not deployed):**
- `lib/onboarding/email.ts` — `sendOnboardingLinkEmail` + `sendOnboardingReminderEmail`
  via the shared `sendBrandedEmail` (schoolId null → generic Growth Suite sender
  for leads). Absolute links from `APP_BASE_URL` (falls back to the vercel domain).
- `app/api/admin/onboarding/[id]/send-link` + an "Email the link" button on the
  detail page.
- `app/api/cron/onboarding-reminders` (migration 073 adds `last_reminded_at` +
  `last_status_at`) — nightly: recomputes + **persists** `percent_complete`/`stage`
  (fixes the per-row recompute-at-scale concern) and nudges schools with
  outstanding actionable items (2-day grace after creation, 4-day reminder
  cadence, fail-closed cron auth). Scheduled in `vercel.json` at 15:00 UTC.

Note: reminders go out **directly via Resend** (we own the status + the email),
rather than routing through GHL — simpler and no agency-GHL-API dependency. A
GHL-contact status writeback (so GHL workflows can also branch on progress)
remains an optional later add if you want reminders inside GHL specifically.

**Env needed:** `ONBOARDING_TOKEN_SECRET` (or `SESSION_SECRET`), `APP_BASE_URL`
(for absolute email links), `RESEND_API_KEY` (already set for other email),
`CRON_SECRET` (already set for other crons).

## Build phases (suggested order)

1. **Truth layer** — data model migration + task registry + `computeOnboarding`
   (reuses the billing-status derivation *technique* over non-billing signals).
   No UI yet; unit-verifiable.
2. **School-facing page** — checklist + doc upload + instructions + magic-link
   auth. (Chosen "school-facing first".)
3. **Ops board** — new `/admin/onboarding` (same grid technique, non-billing
   signals); doc review + manual sign-offs.
4. **GHL sync** — pipeline mapping + nightly status writeback + reminder
   workflows.
5. **Content + polish** — per-step instructions (the non-billing steps from
   SCHOOL_ONBOARDING.md, rewritten for schools), email templates, target-launch
   tracking, "stuck" highlighting.

## How this ties to the self-serve work already shipped

Every `derived` task's "done" state is one of the **non-billing** self-serve
features from this session — parent-portal settings configured, dashboards added
from the gallery, forms published from templates, branding set, field kit
provisioned / audit green, roster synced. So the onboarding portal is the
**guided front-door** that walks a school through standing up their software and
tracks their progress — the capstone that makes "sign up → software built" feel
like one flow instead of a pile of separate tabs. (Billing/tuition setup runs on
the partner's separate track and is intentionally absent here.)
</content>
