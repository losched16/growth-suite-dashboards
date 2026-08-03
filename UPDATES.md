# Growth Suite — Update Log

Running log of platform changes, newest first. Written for reading on a
phone: what changed, where to see it, and anything the office needs to do.
Detailed engineering history lives in the git log; this file is the
human digest.

---

## August 3, 2026

### Attendance: leave and come back, any number of times
A student can now check in, check out mid-day (appointment, early
pickup, anything), and check BACK in — on every surface:
- Kiosk: a checked-out kid's tile says "Checked out at 2:15 — back
  again?" and offers Check in; their morning dismissal time is
  pre-filled on the return trip. (Previously a mid-day checkout also
  wrongly blocked the day's second check-out.)
- Parent portal: "Checked out" is no longer the end of the day — a
  "Check back in" button sits right next to it, and the day card
  shows the whole journey: checked in · checked out · back in.
- Student Roster: the attendance cell shows "in 8:01 · out 11:30 ·
  back 1:15", and the admin In/Out buttons already handled cycles.
- Under the hood, the day's status now follows the LATEST event; the
  old logic froze a day at "checked out" after any departure. All
  history got recomputed with the fix.

### Student Roster: attendance filter
New "Attendance" dropdown (present / not yet / checked out / absent)
plus a "Curbside today" checkbox in the roster filter bar. Combines
with every other filter and flows into the CSV export.

### Day-one kiosk report + duplicate-tap fix
First day of school: 219 students checked in — 113 kiosk check-ins
(every one signed), 22 portal check-ins, the rest via the office. One
issue found and fixed same-day: the roster's admin In/Out button
reloaded to a cached view, so staff re-tapped (one student collected
13 duplicate check-ins). The button now updates in place, the server
refuses same-day duplicates, and the 104 duplicate rows were removed.

---

## August 2, 2026

### Publishing a form now EMAILS the targeted families too
The in-portal bell alone doesn't reach parents who aren't already in
the portal. Publishing a form now also sends each targeted parent an
email through the CRM (visible on their contact's conversation) with
a link straight to the form. Same accidental-republish protection:
within 14 days of a previous notice, no re-blast.

### Emergency card reminders — sent (Clint-approved)
Reminder emails went to 129 of 130 families with an outstanding AZ
Emergency Card (one email per family, listing their student(s), sent
through the CRM so each shows in the contact's conversation thread).
Copy: go back to the July 24 card email, it will NOT appear in the
parent portal, check junk/spam, email admissions@ for a fresh one.
ONE failure: Gonzalez Family — the CRM rejected the address
roasalee.gonzalez@gmail.com as invalid (looks like a typo of
"Rosalee"). Office: please confirm her correct email with the family
and fix it on the contact, then the reminder can be resent.

### Missing finance emails for two MYHS tech agreements — found + fixed
Finance didn't get the submission notices for Kennedi Patrick (Jul 31)
and Leo Champagne (Aug 1) — 17 of 19 tech-agreement notices arrived.
Root cause: notification emails were sent "in the background" after
the parent's submission completed, and the server occasionally shuts
that background work down mid-send. Random, rare, and silent.
Fixed: every form notification (office notices, receipts, admin-change
alerts, webhooks) now completes BEFORE the submission response, and
any per-recipient failure is logged. The two missed notices were
re-sent today — finance@ and admissions@ both received Kennedi's and
Leo's now (delivery confirmed). A replay tool exists for any future
"we never got the email" report.

### Enrollment agreement no longer re-asks already-enrolled siblings
Why the Friend family got agreements for Lola + Tristan: enrolling NEW
sibling Maelynn put the family in Pending, and the pending rule showed
the agreement for every child in the family. Fixed structurally: forms
can now exclude students by enrollment status, and the agreement now
skips any student already marked Enrolled — automatically, using the
CRM-synced status. Verified: the agreement's missing list is now only
genuinely pending students. NOTE for re-enrollment season: remove that
exclusion when you WANT enrolled families re-signing. Still to do for
the office: Maelynn's agreement is unsigned (dad signed the other two
instead); it's waiting in his portal.

### Student document upload — three fixes from the office list
- Uploading from a student's roster row now opens the form ALREADY on
  that student, and the student picker has a type-to-search box.
- Successful uploads show a green "uploaded and attached" banner —
  no more silent reload that looked like nothing happened.
- "Open" on an uploaded document no longer says unauthorized (the
  download opens in a new tab, which lost the login inside the CRM —
  links now carry their own credentials).

### Portal Forms tracker — accurate targeting, grade filter, exports
- The tracker now honors each form's audience per STUDENT: a 6th
  grader is no longer counted as "missing" the MYHS 7-12 tech
  agreement — kids a form doesn't target show as grey non-applicable
  chips and don't drag completion numbers down.
- New Grade filter in the filter bar — scope the whole grid to one
  grade level.
- Two new export buttons: "Export non-submitters" (the chase list)
  and "Export all statuses". Columns: form, family, parent, email,
  phone, student, grade, status, submitted date — pre-sorted by grade
  and honoring the on-screen form + grade filters. Verified live.

### Families are now told when a form is published to them
Publishing a form (Draft → Published in the builder) automatically
sends an in-portal notification — bell + inbox — to exactly the
families the form targets (program/grade/tag rules carry over; an
untargeted form notifies everyone), with a link straight to the form.
Re-publishing within 14 days does NOT re-notify, so an accidental
toggle can't blast families twice. New forms now start as DRAFTS —
publishing is always a deliberate click.

### Flag Football form mystery — answered + hardened
The "DGM Flag Football Registration Form" (a 1.0 import sitting in
drafts since July 2) WAS live for ~3.5 hours on Friday evening
(5:30-8:56 PM): 8 parents from 7 families opened it (Bray, Faber,
Pelton, Pollard, Sinks, Modi, Jimenez), nobody submitted, and it was
switched back to draft at 8:56 PM. It was not any automation — and
as of today the form-save endpoint requires a login (it previously
did not), and publish toggles notify families deliberately.

---

## August 1, 2026 — parents can see their own PIN

### Your PIN, visible to you
Parents now see their own kiosk PIN in the portal — on the Attendance
page (masked, with a Show/Hide button) and under Settings → Pickup
People. Newly saved PINs appear immediately. PINs created before this
upgrade show "set — change it to see it here" until re-saved.
Verified live end to end: set a PIN through the real parent flow on a
test account and confirmed both pages display it back.

---

## August 1, 2026 — kiosk + pickup-people batch

### Kiosk: select who you're moving (nothing pre-selected)
The student screen now starts with NO kids selected — the parent taps
the ones they're dropping off or picking up, instead of un-tapping the
ones they aren't. Confirm stays disabled until at least one is tapped.

### Kiosk: a note box per child, on check-in AND check-out
The single "note for the front desk" that applied to every selected
check-in is gone. Each selected child now has their own note box —
including at pickup — and each note lands on that child's attendance
event (visible on rosters + the new attendance history).

### Pickup people are office-managed, end to end
- Kiosk landing no longer tells grandparents/sitters to "ask the
  parent for a PIN" — it now says pickup people must be authorized in
  advance through the school office.
- Parents already CAN'T self-add pickup people (the portal's add form
  is replaced by a "contact the school office" notice pointing at
  admissions@, and the API rejects direct attempts).
- NEW: the office side. Open a family on the Student Roster → the
  "Authorized for pickup" section now has "Kiosk PINs — office
  managed": add a pickup person (optionally limited to specific
  kids), and the system generates their 6-digit kiosk PIN on the
  spot — shown ONCE, so read it to the parent or email it to them.
  You can also regenerate a PIN or deactivate someone there.

---

## August 1, 2026 — Sonia's list

### Attendance history per student (with signature log)
Every student's Attendance cell on the roster now has a "history"
button → full check-in/out record for any range (2 weeks, month,
3 months, year, or custom dates): time, who performed it, kiosk vs
portal vs office, curbside + notes, and a "view" link showing the
SIGNATURE captured on each event. Plus a Download CSV button.

### MYHS Technology Agreement (7-10) was visible to every family — fixed
Its audience rule included the "parent 1" tag, which every family
carries, plus the MYHS program (which includes 11-12 graders). Now
targeted purely by grade (M7/M8/M9/M0). Verified: a D1 family (Nunez)
sees ONLY the 11-12 agreement; a Primary/Toddler family sees neither.
Note for testers: the Jain TEST family has a D1 student, so seeing
the 11-12 agreement there is correct. Also: both agreements now
notify finance@ + admissions@ (was finance@ + Dana).

### Student roster — alphabetized by first name
Default order (and the Student column sort) is now first name A-Z,
matching how names display. Click any column header to sort another
way.

### Roster document upload — embed link fixed
"Upload / manage in Documents tab" from a roster row now carries the
embed credentials — from inside the CRM it used to land on a blank
unauthorized page. Combined with this morning's category + 50MB
fixes, roster uploads work end to end.

### Drop-off: dismissal time is now a statement, not a question
When a student's classroom maps to exactly one dismissal wave, check-in
just SHOWS the time ("If today's plan is different, let the front desk
know") instead of a one-option radio + Confirm. Kids with multiple
possible waves still get the picker. Each sibling checks in on their
own page with their own classroom's time. Curbside stays a separate
optional dropdown — choosing a time IS the curbside opt-in.

### PIN copy consistency
All portal copy now says 4-8 digits (the banner used to say 4).

### O'Callaghan family (Gabrielle + Ross) — consolidated
They existed as two separate one-child records: Ross had Gemma on his
contact, Gabrielle had Colette on hers, and both contacts carried both
Parent 1 and Parent 2 tags. Now: Gabrielle is Parent 1 with BOTH girls
(Colette + Gemma, all enrollment/financial data) on her contact; Ross
is Parent 2 (communication-only, per policy). Tags corrected on both.
One family in the dashboard/portal; both portal logins and Gemma's
records kept. NOTE: the other O'Callaghan couple (Megan + John, kids
John Jr & Milo) has the SAME split pattern — say the word and I'll
consolidate them the same way (who should be Parent 1?).

### Student document upload — two errors fixed
Both reported this morning (Aayah Khan uploads):
- "invalid_category": picking any of the five standard categories
  (IEP/504, Health, Immunization, Enrollment, Transcript) failed once
  the school had created a custom category (DGM's "Incident Report").
  The validator now accepts the standard categories AND your custom
  ones — exactly what the dropdown shows.
- "file too large": the cap was 10MB, too small for scanned student
  records. It's now 50MB everywhere (form label, upload pipeline, and
  database). Nothing to change on your end — retry the same files.

### Admin check-in / check-out from the Student Roster
The office can now check a student in or out when the parent can't.
On the Student Roster (and every classroom hub) the Attendance column
has small "✓ In" / "→ Out" buttons next to the status chip. One tap
records the event, stamped with the admin's email in the audit trail —
parent kiosk events are untouched. To test: open the Student Roster,
find any student not checked in, tap "✓ In"; the page refreshes and
the status flips to Present with the time.

### Parent check-in PINs — now viewable by the office
Open a family from the Student Roster (tap the row) and each parent
now shows a violet "PIN: ####" badge, so the front desk can read a
forgotten PIN back to a parent. Notes:
- PINs set from now on are viewable. PINs set BEFORE this upgrade show
  "PIN set (not viewable — parent must re-set)": those parents just
  re-save a PIN on their portal Attendance page and it becomes visible.
- Split families: PINs are guaranteed different for every parent. The
  system enforces school-wide uniqueness — if a second parent tries to
  pick a PIN already in use, it's rejected and they must choose another.
  So two parents (same family or split family) can never share a PIN.
- PINs survive the 15-minute CRM sync like passwords do.

### Kiosk — checkout confirmed + signatures now required
- Checkout was already there: when a checked-in student's family enters
  their PIN, that student's tile shows "Check out" instead of "Check in".
- NEW: a finger-drawn signature box now sits above the Confirm button
  and is REQUIRED for every kiosk check-in AND check-out. The kiosk
  won't submit without it, the server rejects unsigned requests, and
  the signature image is stored on each attendance event for licensing/
  audit purposes — same as the in-portal check-in flow.

### Emergency card (AZ Emergency Info & Immunization Record) — who's missing
Fresh pull of every card sent from the CRM, cross-checked against all
300 enrolled students (test families excluded):
- 98 students have a COMPLETED card
- 202 students are MISSING one:
  - 146 sent but never opened
  - 32 viewed but not submitted
  - 24 never sent a card at all
Full list with family, parent, email, phone, student, status and dates:
[reports/2026-08-01-emergency-card-not-submitted.csv](reports/2026-08-01-emergency-card-not-submitted.csv)
(also sent in chat). The "CRM az_card field" column shows what the
contact record claims, for reconciliation — the live document status is
the source of truth.

---

## July 30, 2026

### Portal form confirmations — FACTS messaging scoped to enrollment only
Parents submitting any per-student form (tech agreement, permission slip)
were seeing the "For your FACTS account setup" box on the confirmation
page. That box now appears ONLY on enrollment-agreement submissions.
Every other form shows its own confirmation message (set per form in the
builder) or a clean default.

### Per-form completion notifications — self-serve + safety net
- Who gets emailed when a form is submitted is set per form in the form
  builder: "Notify on submit" field, comma-separated addresses.
- Safety net: if that field is left blank, submissions notify the
  school's admissions address automatically. A newly published form can
  no longer collect submissions silently.
- Both MYHS tech agreements notify finance@ + admissions@ (FACTS charges).

### MYHS Technology Agreements — published and verified
- Grades 7-10 (Chromebook) live, targeted to grades M7/M8/M9/M0.
- Grades 11-12 (Apple laptop) live, targeted to D1/D2.
- Verified per family: MYHS families see the right agreement with a card
  per MYHS student; non-MYHS families see neither. Both have tracker
  columns; submissions flow in automatically.

### "School Documents" section now lists the targeted uploads
The portal nav item DGM labels "School Documents" now shows BOTH the
legacy school resources and the new audience-targeted Important
Documents (each family sees only what their audience includes),
grouped by category. They also still appear on "Parent Documents"
under "From your school". Verified with the office's MYHS Technology
Letter (Program: MYHS targeting followed correctly).

### Check-in PIN setup banner
The portal Attendance page now shows an unmissable banner walking
families through setting their kiosk check-in PIN.

### Chef dashboard (new custom role dashboard)
Every enrolled student with Classroom, Today's attendance (live
check-in status), Allergy, and Lunch. Classroom filter + a
Show: All / Allergies / Hot lunch selector. Print + CSV export.
Nothing else visible. Link shared separately (treat like a password).

### Student roster — Documents column
The full Student Roster now has the same per-student Documents
column as the classroom hubs: view + upload (IEP/504 etc.) from any
student's row. Pairs with the IEP/504 filter for a one-screen
workflow.

### Student document categories — standard presets
IEP/504, Health, Immunization, Enrollment, Transcript are now
permanent preset categories for every school — always in the upload
dropdown and category filter, can't be renamed or hidden by custom
categories. (Previously, creating any custom category hid the
defaults entirely.) The upload form also got a proper blue
"Choose File" button.

---

## July 29, 2026

### Family corrections (all verified end-to-end)
- Johnson: Collette → parent 1 (login + PIN preserved), Jacob → parent 2.
- Lastra Sicardi: Gabriela → parent 1, Jose → parent 2, family renamed
  "Lastra Sicardi Family" via the new Family Display Name field.
- Labak: consolidated to ONE family — Jaime parent 1 with both girls
  (Wynslette slot 1, Cecelia slot 2), Randall communication-only.
- New: "Family Display Name" custom field on the contact record
  overrides the family label everywhere. For compound-surname
  households; office sets it once in the CRM.

### Enrollment co-sign — unmarried joint-LDMA now requires both signatures
Previously only divorced/separated joint-LDMA triggered the second
signature. Now any non-married joint-authority household does.
Retroactively armed on the Russell resubmission; Nicholas Shouse
received his signing link.

### Important Documents (office side)
Lives on the Portal Forms page below the forms manager: upload once,
target by program / classroom / grade / tag / specific family with
AND/OR + excludes, live reach count, Permission Slip + custom category
labels. Fully separate from the per-student Documents dashboard
(IEP/504 uploads), which is unchanged.

### Filter search behavior (all dashboards)
Typing no longer auto-refreshes the page — press Enter to search, and
every filter action keeps your scroll position.

### Classroom hubs
Curbside status + time and daily check-in notes columns added; print
roster produces the 4-column sheet (name / allergy / lunch /
do-not-pickup); Export CSV scopes to the classroom.

---

## July 28, 2026 and earlier (highlights)

- Sync hardening: attendance events and pickup people survive rebuilds;
  automatic alert email if any school's sync fails repeatedly, recovery
  note when healthy. Tag add/removal audit log.
- Teacher rename auto-heal: renaming a dropdown option (e.g. a teacher's
  name) now rewrites all contact records automatically on next sync.
- Pending → portal → enrollment agreement chain verified for all pending
  families; tweeners list delivered (who's missing welcome /
  confirmation / emergency card).
- Submitted portal forms can never disappear from the tracker
  (submissions survive tag changes and sync rebuilds).
- Parent uploads visible office-side: tracker "Uploaded Docs" column,
  family drilldown list, upload notification emails to admissions@ +
  lhenderson@.
- Curbside redesign: per-kid time dropdown at check-in, front-desk note
  box, Attendance & Curbside office dashboard.
