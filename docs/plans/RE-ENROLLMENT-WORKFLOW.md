# Re-Enrollment Workflow — Architecture Spec

*Planning doc. The annual "roll every family to next year and re-sign them"
workflow — a private school's single biggest revenue moment, and a wedge nobody
does specialized for Montessori/K-12. Builds on the enrollment-agreement forms,
co-sign, and enrollment-status field that already exist.*

## Why this matters (the wedge)

Re-enrollment season decides ~80% of next year's revenue for a private school,
and today most run it on paper or generic tools. Owning it — a clean annual
cycle that re-signs every family, tracks who's in/out/at-risk, and forecasts
next year — makes you the system schools *can't* rip out, and it's the sharpest
expression of "own enrollment growth." It's also sticky: it recurs every year
and touches every family.

## Scope + the billing boundary

Re-enrollment here captures the **decision + the signed agreement (intent to
return)** — NOT payment. Deposits and tuition are the **partner's** track. The
agreement form MAY *display* tuition read-only (the form engine already renders
pricing), but this workflow never charges. Signing = commitment; the partner's
system handles any deposit. (Coordinate one handoff: "agreement signed" can
trigger a partner-side deposit request.)

## The lifecycle

```
Open a cycle → Send agreements → Families decide (per student) → Track + nudge
   → Write decisions back to GHL → Roll over at close → Forecast next year
```

1. **Open a re-enrollment cycle** (school or ops): pick the **target year**
   (N→N+1), the **re-enrollment agreement form**, a **deadline**, and the
   **cohort** = currently-enrolled students minus graduating (see edge cases).
2. **Send** — push the agreement to every family in the cohort (reuse the
   existing "send a form to families/groups" + the parent portal / magic link),
   with an intro email.
3. **Families decide, per student** (parent portal): for each enrolled child,
   **"Yes, returning"** → sign the agreement (co-sign to Parent 2 when joint
   custody, via the existing co-sign flow); or **"Not returning"** → capture a
   reason (moving, graduating, financial, other).
4. **Track** — the re-enrollment dashboard: per-family/student status
   (not sent / sent / viewed / signed / declined / **at-risk**), rollup counts,
   % re-enrolled, and a forecast number.
5. **Nudge** — automated reminders to families not yet signed as the deadline
   approaches (reuse the reminder-cron pattern; email/SMS via GHL or Resend).
6. **Write decisions back to GHL** — each student's re-enrollment decision lands
   on the contact (source of truth), so dashboards/portals reflect it.
7. **Roll over at close** — returning students' enrollment advances to the new
   year (record + status); not-returning → Withdrawn for next year; graduating →
   graduated. New younger siblings hand off to the enrollment/admissions flow.

## Data model (new; migrations 076+)

- `reenrollment_cycles` — `school_id`, `from_year`, `to_year`,
  `agreement_form_id` (FK to `portal_form_definitions`), `opens_at`, `deadline`,
  `status` (open/closed), `created_by`, timestamps.
- `reenrollment_records` — one per student in the cohort: `cycle_id`,
  `family_id`, `student_id`, `decision`
  (`undecided`|`returning`|`not_returning`|`graduating`),
  `agreement_status` (`not_sent`|`sent`|`viewed`|`signed`),
  `agreement_submission_id` (FK to `portal_form_submissions`),
  `sent_at`, `viewed_at`, `signed_at`, `not_returning_reason`, `at_risk` bool.
- **GHL writeback field** (per student slot, additive → auto-discovered by the
  field catalog): `Student N Re-enrollment {to_year}` (`Returning` /
  `Not Returning` / `Undecided` / `Signed`). New field = safe additive change
  per the data-layer rule.

## Source-of-truth handling (ties to the data-layer spec)

The re-enrollment **decision is a contact attribute** → it writes to the GHL
contact (a new per-student field), and because it's a *new additive field*, the
living field/tag catalog picks it up automatically and it becomes a **dashboard
filter/column** with no extra wiring ("show me families not re-enrolled"). At
**rollover**, the student's actual `Enrollment Status` advances (returning stays
Enrolled for the new year; not-returning → Withdrawn) — the same field the
rosters already key on.

## Reuse map (this is orchestration, not new primitives)

- **The agreement** = a form: `portal_form_definitions` + `FormRenderer`, with a
  `student_applicability` block so one family agreement captures per-student
  decisions.
- **Co-sign** = `lib/forms/cosign*` + `/cosign/[token]` + the co-sign email —
  joint-custody re-sign is already solved.
- **Send-to-families** = the existing "publish/send a form to specific
  families/groups" feature.
- **Enrollment status field** = `field-kit.ts` ENROLLMENT_STATUS_OPTIONS
  (Enrolled/Pending/Withdrawn…) — the rollover target.
- **Academic year** = `schools.settings.academic_year` (from → to).
- **Reminders** = the onboarding reminder-cron pattern (grace + cadence +
  fail-closed).
- **Forecast widgets** = `EnrollmentTargetsTable`, `EnrollmentByGradeChart`,
  `RecentEnrollments` already exist — feed them the projection.
- **Parent portal** = where families respond (enrollment-agreement UX already
  lives here).

## Edge cases to design for

- **Graduating students** must be excluded from the cohort (a Toddler doesn't
  "re-enroll" out of the top grade — they leave). Needs a per-school
  **terminal-grade** setting (or a grade→promotes-to map). Graduating students
  get a graduation flow / nothing, not an agreement.
- **Per-student within a family** — a family re-enrolls 2 of 3 kids (3rd
  graduates or leaves). Decisions are per student; the agreement is family-facing
  but records each child.
- **New younger siblings** — a re-enrolling family often adds a new child →
  that's a *new enrollment* (admissions), adjacent. Offer "add another child"
  that hands off to the enrollment flow; don't cram it into the agreement.
- **At-risk detection** — viewed-but-not-signed, or no response within X days of
  the deadline → flag + prioritize outreach.
- **Re-enrollment window** — cycles are time-boxed (e.g. Jan–Mar for an Aug
  start); `opens_at`/`deadline` drive nudges and the "closed" rollover.
- **Grade promotion at rollover** — returning students advance a grade. Decide:
  auto-promote via a grade→next-grade map, or leave grade edits to the school.

## Surfaces to build

1. **School re-enrollment dashboard** (`/school/{loc}/re-enrollment`): open a
   cycle, the rollup (% re-enrolled, counts by status, at-risk highlighted),
   a per-family/student table with per-row nudge, and the forecast number.
2. **Parent re-enrollment experience** (parent portal): "Re-enroll {student} for
   {year}" → sign the agreement (co-sign if needed), or "Not returning" → reason.
   Per student, one clear call to action.
3. **Ops cross-school view** — re-enrollment health across all schools (like
   `/admin/billing-status`, but re-enrollment rate + at-risk counts) so you can
   spot a school with a stalling season.

## Forecast (the head-of-school value)

Projected next-year enrollment =
`current enrolled − graduating − not_returning + committed_returning + new_admissions`.
Feed the existing `EnrollmentTargetsTable`. Revenue projection is possible if
tuition grids exist, but tuition is the partner's domain — keep any $ forecast
read-only/optional and clearly "projected."

## Build phases (suggested order)

1. **Cycle + cohort** — data model, "open a cycle" (pick form + deadline),
   cohort selection excluding terminal grades. (Safe — our-DB only.)
2. **Send + parent response** — reuse send-form + co-sign; the parent
   re-enroll/decline experience; write `reenrollment_records`.
3. **Tracking dashboard** — status rollup, at-risk, per-row nudge.
4. **GHL writeback + rollover** — decision → contact field (auto-discovered);
   at close, advance enrollment status + create next-year records.
   **Writes to GHL → test on a non-live sub-account (desktop).**
5. **Forecast** — feed the enrollment-targets widgets.
6. **Reminders/nudges** — the cron + GHL workflows.

## Open decisions

- **Terminal grade / promotion map** — how the school tells us which grades
  graduate and how grades advance. New setting.
- **Deposit handoff** — does "agreement signed" trigger a partner-side deposit
  request? Coordinate the seam with the billing partner.
- **New GHL field vs. reuse enrollment status** for the decision — spec assumes
  a new per-student re-enrollment field (cleaner, additive) + status advance at
  rollover. Confirm.
- **Auto-promote grades at rollover** vs. leave to the school.
- **Revenue forecast** — include a projected-$ view, or enrollment-count only
  (partner owns $)?
