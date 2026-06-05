# Peoria Montessori — GHL ↔ Growth Suite data contract

Last updated: 2026-06-05

The Growth Suite dashboards (Family Hub, Student Roster, etc.) are
rebuilt from Peoria's GHL contacts on every cron tick (~hourly).
**GHL is the source of truth.** Anything you change in GHL flows
into the dashboards within an hour. Anything that's missing in
GHL is missing from the dashboards.

This doc lists the GHL fields, tags, and patterns that drive the
dashboards — the maintenance contract for the school admin.

---

## 1. One contact per family (the primary parent)

The clustering rule is simple: **one GHL contact = one family in
Growth Suite.** The contact represents the primary parent (P1). The
spouse, if any, lives as Parent 2 fields on the same contact —
not as a second contact.

If you have a second GHL contact for the spouse (for email
marketing), that's fine — **just don't set Household ID on it.**
Only the primary's contact gets Household ID.

---

## 2. Required field — Household ID

**Field name:** `Household ID`
**Field key:** `contact.household_id`
**Type:** TEXT

The sync uses this as the "is this contact a family?" gate. A
contact with empty Household ID is treated as a marketing/inquiry
contact and **does not appear in family-hub or student-roster.**

Convention: set Household ID = the contact's own GHL contact id
(any unique string works — what matters is that it's present).

If you create a new family contact in GHL, you must stamp Household
ID on it for it to show up in Growth Suite.

---

## 3. Parent 1 (the contact itself)

| Dashboard field | GHL location |
|---|---|
| Parent 1 First Name | Native `First Name` |
| Parent 1 Last Name | Native `Last Name` |
| Parent 1 Email | Native `Email` |
| Parent 1 Phone | Native `Phone` |

Native fields — no custom fields needed.

---

## 4. Parent 2 (optional — on the primary's contact)

| Dashboard field | GHL custom field key |
|---|---|
| Parent 2 First Name | `contact.parent_2_first_name` |
| Parent 2 Last Name | `contact.parent_2_last_name` |
| Parent 2 Email | `contact.parent_2_email` |
| Parent 2 Phone | `contact.parent_2_phone` |

Setting any one of these creates a Parent 2 row in Growth Suite
for that family. Leaving them all blank means single-parent family.

---

## 5. Students (currently empty — backfill drives student roster)

Peoria's GHL doesn't carry student data yet. **The Student Roster
dashboard will stay empty until you start filling in student fields
on each family's contact.** Three student "slots" are supported per
family:

### Slot 1 (the only required slot if you want any student to show)

| Dashboard field | GHL custom field key |
|---|---|
| Student First Name | `contact.student_first_name` *(already exists)* |
| Student Last Name | `contact.student_last_name` *(already exists)* |
| Student Preferred Name | `contact.student_preferred_name` |
| Student Birth Date | `contact.student_birth_date` |
| Student Gender | `contact.student_gender` |
| Student Grade Level | `contact.student_grade_level` |
| Student Program | `contact.student_program` |
| Student Homeroom (classroom) | `contact.student_homeroom` |
| Student Enrollment Status | `contact.student_enrollment_status` |
| Student Start Date (current year) | `contact.student_current_year_enrollment_start_date` |
| Student Lead Teacher | `contact.student_lead_teacher` |
| Student IEP (yes/no) | `contact.student_iep` |
| Student 504 Plan (yes/no) | `contact.student_504_plan` |
| Student Daily Schedule | `contact.student_daily_schedule` |
| Student Allergy | `contact.student_allergy` |

### Slot 2 (second student in the family)

Same as slot 1 but prefixed with `student_2_`. Example:
`contact.student_2_first_name`, `contact.student_2_homeroom`.

Slot 1's first/last name fields already exist on Peoria's GHL (they
were set up for the inquiry form). The others need to be added.

### Slot 3

Same convention — `contact.student_3_first_name`, etc.

### Enrollment status values (for `student_enrollment_status`)

The sync normalizes these to one of:
`inquiry`, `tour_scheduled`, `application_submitted`, `accepted`,
`enrolled`, `waitlisted`, `withdrawn`, `declined`

Anything unrecognized is treated as `enrolled`.

---

## 6. Optional financial fields (per student slot)

Useful when you want tuition / fees to roll up in the family hub
"Total Tuition" column. Add as needed; all live on the primary
contact, prefixed by slot:

`contact.student_<N>_tuition_fee`, `contact.student_<N>_extended_day_fee`,
`contact.student_<N>_lunch_fee`, `contact.student_<N>_payment_plan`,
`contact.student_<N>_financial_aid`, `contact.student_<N>_sibling_discount`,
etc.

The sync auto-captures any custom field starting with `student_<N>_` —
the dashboard accordion shows them in an "Other" bucket if it doesn't
have a curated label.

---

## 7. Tags Growth Suite reads (the existing imports)

| Tag | What it means | Where used |
|---|---|---|
| `current-parent` | Active parent of an enrolled student | Family Hub gate (combined with Household ID) |
| `alumni` | Former family / community email | Filtering — not surfaced in family-hub |
| `mailing-list-general` | General community subscriber | Email segmentation |
| `staff` | School staff / teachers | Filtered out of parent dashboards |
| `parent` | Generic parent (inline tag from Mailchimp import) | Cosmetic — no behavior |
| `christmas-party` | Mailchimp segmentation tag | Cosmetic — no behavior |
| `follow-up`, `warm lead`, `high priority` | Marketing funnel signal | No dashboard behavior — for GHL CRM use |

**Tags do not drive the dashboards by themselves.** Household ID
gates membership. Tags are for segmentation, marketing, and filters
inside GHL.

---

## 8. Admissions Pipeline → Prospective Families (future)

Growth Suite also creates "prospective family" rows from opportunities
in the Admissions Pipeline when a contact has an open opportunity but
no Household ID. The pipeline stage maps to enrollment_status:

| Pipeline stage | enrollment_status |
|---|---|
| Interest | `inquiry` |
| Inquiry | `inquiry` |
| Tour Scheduled | `tour_scheduled` |
| Tour Show | `tour_scheduled` |
| Application Submitted | `application_submitted` |
| Shadow Visit Scheduled / Completed | `application_submitted` |
| Offer Made | `accepted` |
| Offer Accepted | `accepted` |
| Enrolled | `enrolled` (also requires Household ID) |
| Documents Completed | `enrolled` (also requires Household ID) |

The opportunity name should follow the convention
`<Student First Name> <Student Last Name> — <Year>` so the sync can
parse out the student name for the prospective family.

---

## 9. Snapshot semantics — what the cron does

The sync runs hourly. Each run for Peoria:

1. **Wipes** every family, parent, student, enrollment, and
   classroom row for the school.
2. **Re-reads** every GHL contact with `household_id` set, plus any
   open opportunities.
3. **Re-creates** family / parent / student rows fresh from GHL.

This means:

- **Changes made directly in the DB are erased.** Always edit the
  source data in GHL.
- **Removing Household ID from a contact removes the family from
  dashboards** on the next sync (within an hour).
- **Adding new families is a matter of creating the GHL contact +
  setting Household ID + filling in fields above.**

A one-school-at-a-time exception: Peoria has the
`allow_parent_only_families` flag enabled in its
`school_field_schemas` row. This is what lets the 41 current-parent
families survive even though no student fields are filled in. Once
you start filling student data, students show up automatically.
You don't need to flip the flag off.

---

## 10. Adding new students to existing families

Two patterns work:

**Quick way** — fill the student slot fields on the primary's
contact:
1. Open the parent's contact in GHL.
2. Fill `Student First Name`, `Student Last Name`, etc. (slot 1).
3. For a second child, fill `Student 2 First Name`, etc.
4. Within an hour the student appears under the family in Growth
   Suite's Student Roster.

**Pipeline way** (for inquiries / applicants):
1. Create an opportunity in the Admissions Pipeline.
2. Title it `<First> <Last> — <Year>`.
3. Move it through the stages as the family progresses.
4. Growth Suite's funnel tracker shows them in the right stage.

---

## 11. Quick checklist for adding a new family

- [ ] Create GHL contact for primary parent
- [ ] Set First/Last/Email/Phone on the contact (native fields)
- [ ] Set `Household ID` = contact's own id (or any unique string)
- [ ] If two parents, set `Parent 2 First/Last/Email/Phone` on the
      same contact (no separate spouse contact needed for family-hub)
- [ ] Apply tag `current-parent`
- [ ] (Optional) Fill `Student First Name` + other student-slot fields
- [ ] Wait up to 1 hour for cron; family appears in Family Hub

