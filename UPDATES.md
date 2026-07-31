# Growth Suite — Update Log

Running log of platform changes, newest first. Written for reading on a
phone: what changed, where to see it, and anything the office needs to do.
Detailed engineering history lives in the git log; this file is the
human digest.

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
