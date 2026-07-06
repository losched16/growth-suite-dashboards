# Admissions Funnel — Architecture Spec

*Planning doc. The front half of the enrollment lifecycle: inquiry → tour →
application → decision → enrolled. Pairs with the re-enrollment spec (the back
half) so Growth Suite owns the whole cycle — and it's where the "Growth Suite =
enrollment growth" positioning actually lives, because filling seats is the
school's #1 pain and #1 spend.*

## What already exists (this is orchestration, not net-new)

- `lib/widgets/components/AdmissionsFunnelStages/*` — a funnel widget already
  renders stage counts.
- `lib/sync/pipeline-stage-map.ts` — maps GHL pipeline stages to funnel steps.
- `lib/ghl/pipelines.ts` — `fetchPipelines`, `fetchAllOpportunities`,
  `buildStageLookup`, `indexOpportunitiesByContact` (read the pipeline).
- `lib/sync/create-family-from-contact.ts` — turns a contact into a family
  (the conversion primitive).
- `schools.settings.portal_gate_stage` — already gates parent-portal access to a
  pipeline stage (e.g. "Pending"), so stage already drives product behavior.
- `EnrollmentTargetsTable` / `EnrollmentByGradeChart` — forecast surfaces to feed.

So the pieces are there. What's missing is the **workflow**: standardized stages,
inquiry capture, tour/application tie-ins, the decision → convert-to-enrolled
action, source attribution, stuck-lead detection, and the forecast.

## Source of truth (ties to the data-layer spec)

A prospect is a **GHL contact + opportunity in the admissions pipeline**; the
**stage is the source of truth** for where they are. The app **reads** stage via
the sync and never fights it. The `Enrollment Status` field
(Enrolled/Pending/Accepted/Waitlisted/Withdrawn/Declined) mirrors the decision on
the contact. New signals (e.g. lead source, tour date) are additive fields →
auto-discovered by the field catalog → usable as funnel filters with no wiring.

## The GHL-UI-only constraint (important)

Pipelines and workflows **cannot be created via the GHL API** — they ride the
**snapshot** (same as the field kit's snapshot story). So the *standardized
admissions pipeline* is provisioned by cloning the Growth Suite snapshot, and the
app provides the **stage → funnel-step mapping config** on top (extending
`pipeline-stage-map.ts`), the same way the field schema is derived rather than
imposed. Don't try to create the pipeline from code.

## Standardized funnel stages

A canonical ladder the app maps every school's pipeline to:

```
Inquiry → Tour Scheduled → Tour Completed → Application Started →
Application Complete → Offer Made → Accepted (→ Enrolled) | Waitlisted | Declined
```

Schools keep their own stage *names* (mapped to these steps) — structure
standardized, vocabulary theirs, same principle as everything else.

## The lifecycle flow

1. **Capture an inquiry** — a website/social form or funnel creates the GHL
   contact + opportunity at **Inquiry**, with **lead source** captured
   (attribution: website / social / referral / walk-in).
2. **Schedule a tour** — the prospect books via the tour calendar (the marketing
   module) → stage → **Tour Scheduled**; after → **Tour Completed** (with a
   no-show path).
3. **Application** — send the application form (reuse the form engine) → stage →
   **Application Started / Complete**.
4. **Decision** — school makes an **Offer**, then **Accepted / Waitlisted /
   Declined**. Sets stage + `Enrollment Status`.
5. **Convert to enrolled** — on Accepted, the **conversion seam** (below) creates
   the student/enrollment, flips status to Enrolled, and hands off to onboarding
   (enrollment agreement + portal access).
6. **Nurture the rest** — non-converting leads get automated follow-up (GHL
   workflows); stalled leads are flagged for outreach.

## The conversion seam (the key handoff)

Accepted prospect → enrolled student is where three specs meet:
- Reuse `create-family-from-contact.ts` to materialize the family/student (or
  attach to an existing family for a sibling).
- Set the student's `Enrollment Status = Enrolled` on the GHL contact.
- Trigger the **enrollment agreement** (a form + co-sign) — same primitive the
  re-enrollment spec uses.
- Grant **parent portal access** (the gate stage already exists).
- This is the moment a *lead* becomes a *family* in the system.

## Data model (minimal — mostly read model + config)

- `admissions_config` (per school) — `pipeline_id`, `stage_map` (GHL stage →
  canonical funnel step), `application_form_id`, `tour_calendar_id`. Derived at
  provisioning like the field schema; editable by ops.
- Everything else (who's at what stage, counts, time-in-stage, source) is a
  **read model** derived from synced contacts + opportunities. Store lead source
  + tour date as additive GHL fields, not app tables.

## Metrics + forecast (the head-of-school value)

- **Funnel:** count at each step + **conversion rate** between steps (Inquiry→
  Tour, Tour→App, App→Offer, Offer→Enrolled).
- **Velocity:** average time-in-stage; **stuck leads** (in a stage too long).
- **Attribution:** enrollments by lead source — which channels actually fill
  seats (this is the marketing ROI story).
- **Forecast:** projected new enrollments = pipeline × stage conversion rates →
  feed `EnrollmentTargetsTable`. Combined with re-enrollment's returning count =
  **total projected next-year enrollment**, the number a head of school lives by.

## Reuse map

`AdmissionsFunnelStages` widget, `pipeline-stage-map.ts`, `lib/ghl/pipelines.ts`
(opportunity reads), `create-family-from-contact.ts` (conversion),
`portal_gate_stage` (portal access by stage), the form engine (inquiry +
application forms), the tour calendar (marketing module), GHL workflows
(nurture), `EnrollmentTargetsTable` (forecast), the reminder-cron pattern
(stuck-lead nudges).

## Edge cases

- **Attribution** — capture lead source at inquiry; without it the marketing-ROI
  view is blind.
- **Tour no-shows** — a path back to nurture, not a dead end.
- **Waitlist management** — waitlisted prospects need their own view + a promote
  action when a seat opens.
- **Offer expiration** — offers should have a deadline + auto-nudge.
- **Sibling of an existing family** — a re-enrolling family adding a child enters
  admissions but attaches to the existing family (the re-enrollment spec's "new
  sibling" handoff lands here).
- **Grade/program availability** — an offer may depend on open seats in a
  grade/program; surface capacity vs. demand.

## Surfaces to build

1. **School admissions dashboard** (`/school/{loc}/admissions`): the funnel with
   conversion rates, time-in-stage, stuck leads, source attribution, and the
   new-enrollment forecast. (Extends the existing funnel widget into a workflow
   view.)
2. **Prospect detail / decision** — view a prospect, move stage, make an
   offer, and **convert to enrolled** (the seam above).
3. **Inquiry capture** — the public form/funnel that seeds the pipeline.
4. **Ops cross-school view** — admissions health across schools (conversion
   rates, stuck-lead counts) to spot a school with a leaky funnel.

## Build phases

1. **Config + read model** — `admissions_config` + stage mapping; surface the
   funnel with conversion rates + velocity from synced opportunities. (Safe —
   reads GHL, our-DB writes only.)
2. **Attribution + stuck-lead detection** — lead source (additive field) +
   time-in-stage flags + nudges.
3. **Application form + tour tie-in** — wire the forms/calendar into stages.
4. **The conversion seam** — Accepted → create student + status + enrollment
   agreement + portal. **Writes to GHL → test on a non-live sub-account.**
5. **Forecast** — feed `EnrollmentTargetsTable`; combine with re-enrollment for
   total projected enrollment.
6. **Nurture + waitlist** — GHL workflows + a waitlist view/promote action.

## Open decisions

- **Application fee** — a small payment. Partner's billing domain, or a simple
  Stripe collection here? Coordinate the seam.
- **Capacity model** — do we track seats-per-grade to drive waitlist/offer
  decisions, or leave capacity to the school's judgment?
- **How much of nurture is GHL vs. app** — recommend GHL workflows own the
  sequences; the app owns the funnel truth + the convert action.
- **Where lead-source attribution comes from** — funnel/form hidden fields, UTM
  capture, or manual — needs a standard.
