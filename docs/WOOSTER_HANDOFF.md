# Montessori School of Wooster — Growth Suite Handoff

A self-serve guide for the Wooster admin team. Covers what's running, how
to use it day-to-day, how to make edits, and what to do when something
looks wrong.

> Last updated: May 2026. If you spot something out of date, ping Clint.

---

## Contents

1. [30-second overview](#30-second-overview)
2. [URLs & logins — cheat sheet](#urls--logins--cheat-sheet)
3. [Enrollment Hub — daily ops walkthrough](#enrollment-hub--daily-ops-walkthrough)
4. [Payments dashboard — daily ops walkthrough](#payments-dashboard--daily-ops-walkthrough)
5. [Portal Forms dashboard — daily ops walkthrough](#portal-forms-dashboard--daily-ops-walkthrough)
6. [Parent portal — what parents see](#parent-portal--what-parents-see)
7. [Common edits — how to make changes](#common-edits--how-to-make-changes)
8. [FAQ](#faq)
9. [When something looks wrong](#when-something-looks-wrong)

---

## 30-second overview

Wooster runs three operational dashboards inside your GoHighLevel
(GHL) workspace, and a separate parent portal at a public URL.

| Surface | Audience | Where |
|---|---|---|
| **Enrollment Hub** | Wooster admin | Inside GHL (embedded) |
| **Payments dashboard** | Wooster admin / billing | Inside GHL (embedded) |
| **Portal Forms dashboard** | Wooster admin | Inside GHL (embedded) |
| **Parent portal** | Wooster families | Public URL — parents log in with email + password |

Everything is linked to **Montessori School of Wooster's GHL location**.
Forms parents submit show up in your dashboards in real time. Tuition,
emergency contacts, allergies, etc., live in our database and can be
pushed back to GHL contact records on demand.

Current footprint as of this handoff:
- **297 students** · **208 families** · **342 parents** · **308 active enrollments**
- **8 published forms** + 1 demo draft · **803 form submissions** to date
- **15 invoices** seeded from your FACTS data

---

## URLs & logins — cheat sheet

### For Wooster admin (you)

| What | URL |
|---|---|
| GHL workspace (Wooster location) | `https://app.gohighlevel.com/v2/location/tFP5UnlBYQayjettNeuG` |
| Embedded admin dashboards | Open them from inside GHL via your Custom Menu Links (Enrollment Hub / Payments / Portal Forms) |
| Direct test (bypass GHL — for QA only) | Append `?embed_token=<TOKEN>` to any `/school/tFP5UnlBYQayjettNeuG/...` URL. Ask Clint for the current token. |
| Operator back-office (Clint's side) | `https://growth-suite-dashboards.vercel.app/admin/2c944223-b2ad-45e1-8ba4-a4b616e4c29a` — requires the operator password |

### For Wooster parents

| What | URL |
|---|---|
| Parent portal home | `https://portal.woomontessori.org` |
| Direct form link (template) | `https://portal.woomontessori.org/forms-v2/<slug>` — see the form list below for slugs |

Parents log in with their **email** + a **password** they set themselves
(first-time visitors hit a "set your password" flow).

### Demo parent for testing

You can log in as a real Wooster parent to walk through the experience.
Ask Clint for a seeded demo account if one's needed for your team
training.

---

## Enrollment Hub — daily ops walkthrough

**What it shows:** every currently-enrolled student for 2026-27, grouped
by Montessori program (Toddler / Primary / Lower El / Upper El / Middle
School). Inquiries and prospects are excluded — this is only kids who
have an active enrollment row.

**Things you can do here:**

1. **See who's enrolled where.** The table groups students by program.
   Click any column header to sort.
2. **Filter.** Use the filter row at the top — by program, grade level,
   schedule, etc. Filters auto-apply (no Apply button to click).
3. **Open a family.** Click any family name to expand an inline
   accordion showing parents, other students in the family, contact
   info, and roster permissions.
4. **Open in GHL.** Family rows include an "Open in GHL" deep-link that
   takes you straight to the GHL contact record.

**Common questions teachers/admin ask of this dashboard:**

- "Who's enrolled in Upper El this year?" → filter by program
- "How many kids in Middle School?" → look at the count at the top of
  that section
- "What's this family's phone number?" → click the family row, see
  contact info in the accordion
- "Which parent gets the bill?" → primary parent shows a green
  "primary" badge in the accordion

---

## Payments dashboard — daily ops walkthrough

**What it shows:** daily payment KPIs (collected today, this week, this
month), a financial-aid queue, and family-level billing operations.

**Things you can do here:**

### KPIs at the top
- Today / This week / This month totals
- Pending FA applications count
- Past-due invoices count

### Financial Aid queue
- Every FA application that hasn't been approved or denied
- Click into an application → see the supporting docs the family
  uploaded, the household income they reported, and the award
  recommendation
- Mark as approved/denied — sends an email to the family

### Family billing
- Search any family by name → see their invoices, payment history,
  autopay status, balance due
- Send an invoice reminder
- Trigger an autopay run for an overdue invoice

**Common admin tasks:**

- **"Did the Smith family pay?"** → Search "Smith" → balance shows at
  top. Recent payments below.
- **"How much have we collected this week?"** → Top KPI strip.
- **"Send a reminder to all past-due families"** → Past-due section
  has a "Remind all" button (sends the templated reminder email).
- **"Approve Jenny Smith's FA application"** → FA queue → click into
  her application → Approve.

---

## Portal Forms dashboard — daily ops walkthrough

**What it shows:** native parent-portal form submissions — both a
completion tracker (which families have / haven't completed each
required form) and a feed of recent submissions.

**Things you can do here:**

### Completion tracker
- Pick a form from the dropdown (e.g. "Enrollment Agreement")
- See every active family with a column showing their status: ✅ done,
  ⏳ pending, or ❌ not started
- Click any family's status → opens the submission to view
- Click "Send reminder" on any pending row → emails the family
  reminder to complete the form

### Recent submissions feed
- Newest at the top
- Each row shows: form name, family, student (for per-student forms),
  submitted-at, and a "View" link
- Click "View" → see the full responses (every field they filled in,
  plus any signatures / uploads)

### Forms list (the 8 currently published)
- Emergency Medical Information
- Enrollment Agreement
- Health Conditions
- Health History
- Injury History
- Media & Roster Permissions
- Medications
- ODE Connectivity Survey

(Plus 1 draft: "Class trip — preview" — hidden from parents.)

**Common admin tasks:**

- **"Who hasn't filled out the Enrollment Agreement?"** → Completion
  tracker → pick that form → filter to "pending" or "not started"
- **"What did the Smith family put for allergies?"** → Recent
  submissions → search Smith → click View on their Emergency Medical
- **"Send a reminder to everyone still pending"** → Bulk send from the
  completion-tracker view

---

## Parent portal — what parents see

When a Wooster parent goes to
`https://portal.woomontessori.org` and logs in, they land
on **their home page** which shows:

- A **"Pending forms" banner** if any required forms haven't been
  submitted for any of their children. Click any pending form to fill
  it.
- A **kids overview** — one card per child, with quick links to that
  child's forms / documents / attendance.
- **Recent messages** from the school (if any).

### Other pages parents have access to:

| Page | URL path | What it does |
|---|---|---|
| Home | `/home` | The dashboard above |
| My Family | `/family` | Household — parents + students, edit contact info |
| Forms | `/forms-v2` | Every form they can fill, split into "action needed" and "completed" |
| Form history | `/forms-v2/history` | Past submissions, drill in to view |
| Billing | `/billing` | Open invoices, payment history, autopay status |
| Tuition plan | `/tuition` | Pick monthly / pay-in-full / etc. |
| Payment methods | `/billing/payment-methods` | Add / remove card |
| Messages | `/messages` | Two-way messaging with school |

### Privacy boundaries (important)

- Parents only see **their own family's** data — never other families.
- Both parents in a divorced couple see the same family by default,
  but either parent can mark their personal contact info as "private
  from co-parent" in `/family` settings. School staff always see the
  full record.

### What a parent CANNOT do

- View other families' forms or contact info
- Edit other parents' contact info (only their own)
- Access dashboards (those are admin-only — `/school/...` URLs)
- Change which children are in their family (only admin can re-assign
  a student between families)

---

## Common edits — how to make changes

Every operation in this section can be done from inside the embedded
admin dashboards (no developer needed).

### Forms — publish, unpublish, delete

Open **Portal Forms** dashboard → look at the form list.

Each row has two buttons:

- **Published / Draft toggle** (green when published, amber when draft)
  - Click to flip. Drafts are **hidden from parents** instantly.
  - Use Draft to seasonally retire a form (e.g. retire the field trip
    form when no trip is coming up) without losing historical
    submissions.
- **Delete** (red)
  - Click → confirmation modal showing the submission count
  - **0 submissions** → one-click delete
  - **N submissions** → must type `DELETE` to confirm. Will also wipe
    those N parent submissions permanently. Prefer flipping to **Draft**
    if you might want the data back.

### Forms — edit a form's fields or text

Open **Portal Forms** dashboard → click **Edit** on any form row.

You'll get the form editor. You can:

- Change the title, description, and category
- Edit a field's label, help text, or required flag
- Reorder sections
- Add a new field (text / dropdown / signature / etc.)
- Toggle the form per-student vs per-family

You CANNOT:
- Change a field's `type` once submissions exist (would orphan
  responses)
- Edit the form's slug (the URL) — it'd break shared links

### Forms — create a brand-new form

For now, ping Clint with the form content (PDF, Word doc, or even a
photo of a paper form) — we'll add it via a seed script. Self-serve
form creation is on the roadmap.

### Students — add a new student to a family

Currently a Clint operation. Send him:
- Family's primary parent name + email
- Student's first/last name, DOB, gender
- Which program/grade

He'll add the row and you'll see them in the Enrollment Hub
immediately. Self-serve student creation is on the roadmap.

### Students — fix a misspelled name or wrong DOB

Currently a Clint operation. Self-serve student editing is on the
roadmap. Workaround: parents can edit some fields via the parent
portal `/family` page (the next form they submit will save corrected
info to the health profile).

### Parents — add a second parent to a family

Parent can self-serve: log in → `/family` → "Add household member".

### Tuition — adjust a family's plan

Open **Payments** dashboard → search the family → click into their
billing record → "Change plan" option. Or, the parent can self-serve
from `/tuition` if they have the option enabled.

### Notification emails — change who gets notified when a form is submitted

Currently a Clint operation. Tell him "for the Health History form,
notify nurse@wooster.org and admin@wooster.org" and he'll update the
notify list.

---

## FAQ

### General

**Q: Where does the data come from?**
- Initial import: Final Forms export (students, families, parents,
  health profiles) + your FACTS export (tuition).
- Ongoing: every form a parent submits in the parent portal updates
  the relevant records. Parent-edited contact info syncs immediately.

**Q: Is anything pushed back to GHL automatically?**
- Yes — we write tuition status, allergy flags, and a handful of
  custom fields back to the GHL contact record so your workflows see
  current info. The writeback is **append/update, never delete**, so
  we never overwrite something you typed manually in GHL.

**Q: Can the parent portal be branded with our colors / logo?**
- Yes, partially. Brand color + logo are configurable per school.
  Ping Clint with your brand hex code + a logo PNG and he'll set it.

**Q: How do parents reset their password?**
- "Forgot password" link on the login page sends a reset email. If
  they're not getting it, check that the email on their parent record
  is correct (spam folder first, then check the record).

**Q: What happens to data when a student withdraws?**
- Their enrollment row gets marked inactive (status changes).
  Historical form submissions and tuition records stay. They won't
  appear in the Enrollment Hub anymore but the parents still see them
  in their portal.

### Forms

**Q: Can two parents submit the same form?**
- Yes, but the second submission overwrites the first by default.
  Both parents see a warning ("your co-parent already submitted this
  — do you want to overwrite?") before they confirm.

**Q: A parent says they submitted a form but I don't see it.**
- Open the Portal Forms dashboard → Recent submissions → search by
  family name. If it's there, check the submission's "Resolved" status
  — could be pending review. If it's not there, ask the parent to log
  back in and try again (might be a session issue).

**Q: How do I see who hasn't submitted a required form yet?**
- Portal Forms dashboard → completion tracker → pick the form → filter
  by "pending" or "not started".

**Q: Can I require a form for new families only?**
- Not yet self-serve, but ping Clint and he can configure per-form
  enrollment-year scoping.

### Payments

**Q: A family says they paid but the dashboard shows past-due.**
- Stripe webhook may have failed. Open the family's billing record →
  click "Refresh from Stripe" (or ping Clint if that button isn't
  there yet).

**Q: How do FA applications get reviewed?**
- Family submits via parent portal → application lands in your
  Payments dashboard → FA queue. You review the household income, any
  uploaded documents, and approve/deny. The family gets an email.

### Privacy & access

**Q: Can a non-custodial parent see the other parent's contact info?**
- By default, yes — both parents in a family see each other's contact
  info on `/family`. If a parent flips "Make my contact info private
  from co-parent" in their settings, the other parent sees their info
  redacted. **You (admin) always see the full record.**

**Q: Can a divorced parent be marked "do not allow pickup"?**
- Yes — open the family's record in Enrollment Hub, expand the
  accordion → "Pickup restrictions" → add the person's name + reason.
  Will show up as a red chip on attendance rosters (when those are
  enabled for Wooster).

---

## When something looks wrong

**Symptom → likely fix:**

| Symptom | What to try first |
|---|---|
| Dashboard shows blank or "loading…" forever | Refresh the iframe. If still broken, open in a new browser tab to rule out GHL embedding issues. |
| Wrong family/student showing up | Use the search box. If a search returns nothing, the record may not exist yet — check with Clint. |
| A form I expected to see is missing from the Forms list | Check the **Drafts** section below the Published list — it may have been unpublished. |
| Parent says login isn't working | Confirm email on their record matches what they're typing. Reset password via the "forgot password" link. |
| Parent says they can't see their child's form | Their child may be on a different `family_id`. Check Enrollment Hub for that student — if the parent isn't on the family, ping Clint to merge. |
| Numbers don't match what FACTS shows | The FACTS export may have been a snapshot; we don't sync in real-time. Ping Clint to re-import if discrepancies are recent. |
| GHL workflow isn't firing on form submission | Check the form's `notify_emails` list — if your office address isn't there, the email doesn't go out. Have Clint add it. |

### When to ping Clint vs handle yourself

**Handle yourself (covered above):**
- Publish/unpublish a form
- Delete a stale form with no submissions
- Send a parent a reminder email
- Approve/deny an FA application
- Search and view any family's data
- Edit a form's labels or add/remove a field

**Ping Clint:**
- Add a new student or family
- Fix a misspelled student name / wrong DOB
- Create a brand-new form
- Change who gets notified on a form
- Re-import FACTS data
- Set up a new brand color / logo
- Anything involving Stripe Connect / payment processor config
- "Two records look like the same student" — duplicate merge

### Direct contact

For anything urgent: text/email Clint directly. For non-urgent
"can you also…" requests: queue them up and we'll batch.

---

*This document lives in the codebase at `docs/WOOSTER_HANDOFF.md`. If
you find something wrong or want to suggest an addition, ping Clint
and he'll update.*
