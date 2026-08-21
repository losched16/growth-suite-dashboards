# MCS (Montessori Children's School) — contact restructure, 2026-08-21

Source: the school's "Montessori Growth Suite Input" sheet (166 students, 114 families, program + Current/New/Staff tags, Parent 1 / Parent 2 names).
Scripts: `growth-suite-parent-portal/scripts/mcs-recon.mjs` (read-only reconciliation), `scripts/mcs-restructure.mjs` (dry-run / `--apply`).

## Before
- 279 contacts. The school had entered **each parent as their own contact, each carrying the child's student fields** — 33 "Parent 2"-tagged contacts and 27 untagged dad contacts held student slots → duplicate students.
- No household key → the DG-default sync gate dropped most families: **69 families / 49 enrolled** in the platform.

## Model applied (same as DGM / Wooster)
- **Parent 1 contact = the family record.** All children in Student 1–4 slots; new per-student dropdowns **Student N Enrollment Status** (`student[_N]_enrollment_status`) and **Student N Program** (`student[_N]_program`: Stepping Stones / Primary / Lower Elementary / Upper Elementary / Adolescent); Parent 2 in `parent_2_first_name/last_name/email/mobile`; extra adults in `parent_3_name` / `parent_4_name`; tags per sheet (program tags ∪ Current/New/Staff, `parent 1`, `parent`).
- **Parent 2 contact = communication mirror.** Tagged `parent 2` + `parent`, `parent 1` removed, **student fields cleared**. Linked to Parent 1 via the co-parent association (`promote_parent2`). **Tags mirror from P1 every 15 min, including removals** (`mirror-p2-tags`), so "email all Lower Elementary families" reaches both parents. Only tags — never student data.
- Parent 1 = the sheet's first-listed parent when that contact existed (100); the existing contact that already held the child when it didn't (12 — Rusty Knox, Peter Willett, Jason Murphy…; the sheet's P1 became the Parent 2 field); 2 aliases (Naneshka Pagan Velez; "Kyla Hou" contact renamed **Lijuan Wei** since it already held Caisheng Hou as P2).
- Dashboards read Parent 1 only (sync skips `parent 2`-without-`parent 1` in Phase 1 AND — fixed today — Phase 2 pipeline prospects).

## Numbers after
| | |
|---|---|
| Contact updates | 139 (114 P1 + 25 P2 mirrors), 0 failures |
| Students added to a slot | 45 (+1 duplicate slot cleared: Amelia Hays ×2) |
| **Enrolled** | **166 / 114 families** — matches the sheet; 0 duplicates |
| Parent 2 promoted/linked | 162 of 173 P2 rows (114 promoted today + 41 already + 7 after the phone-dup fix) |
| Parent 2 without email | 17 (11 in enrolled families — CSV `MCS_parent2_missing_email.csv` sent to Clint) |
| Families with no Parent 2 on the sheet | 38 (10 enrolled) |

Platform config: `school_field_schemas` row (householdId '' , parent2 phone = `parent_2_mobile`, student enrollmentStatus/program roles), `schools.settings.promote_parent2 = true`, Student Roster `enrolled_only` + 2026-27.

## Platform fixes shipped (all schools)
- `upsertContactByEmail`: on GHL "does not allow duplicated contacts", re-search by email then **phone** (E.164); if the only match is Parent 1's own contact (shared household line) create P2 **without** the phone. (7 MCS families hit this.)
- Sync Phase 2 (pipeline → prospective families) now skips co-parent mirrors, so a Parent 2's pipeline card can't duplicate the child (Tyler King / Jace King).

## For the school
- Add **Parent 2 Email** on the Parent 1 contact for the 11 enrolled families in the CSV → their contact is created and tagged automatically (15-min cycle); no contact to create by hand.
- Children on a Parent 1 contact that are NOT on the sheet were left as-is (not enrolled): Janalee Bible, Misael Hervey, **Noah Ortega Pagan (sheet says Milan)**, Evelyn Saenz, Gwyneth Hays, **Vladimir Ybarra (sheet says Theodore)** — confirm whether these are renamed children or siblings.
- Talena Weber's contact listed Tennille Weber as Parent 2; sheet says Gareth Goans → replaced (Tennille's email removed from the field).
- Name variants kept as the contact name: Hannah Hatfield (sheet "Hannah Smith"), Brittany Kaczkowsky ("Henson"), Rucsandra Shanahan ("Ada"), Chrissy Page ("Christine").
- Their intake form sometimes tags BOTH parents `Parent 1` (e.g., Muriah King / Joseph Portillo, 2026-27 applicant) — the mirror can't tell who the co-parent is then. Parent 1 = the contact with the student fields; Parent 2 should only get `Parent 2`.
- Pipeline cards still live on whichever parent's contact the school created them under (e.g., "Jace King" on Tyler). Harmless to dashboards now; move them to Parent 1 if they want a clean pipeline.
- Amanda Cruz has a staff contact (`acruz@mcsjax.org`) separate from the family contact — left alone.

## Addendum (same day) — empty roster + classroom dashboards
- **Student Roster showed nothing** after the restructure: the MCS roster and immunization widgets still carried the legacy `enrolled_stage_names: ["Spot Accepted","Enrolled"]` gate (students must have a pipeline card in those stages) from when MCS's roster was pipeline-driven. Enrollment is field-driven now → gate removed on every MCS widget (also the `enrolled_tag`/`excluded_tag` tag gates on Portal Forms). Roster now shows 166; filters = Classroom (homeroom) · Program · Schedule · Lead teacher · Allergies · IEP/504.
- **Classroom = program** for MCS (no per-student classroom field; the `classroom` contact field is empty on every contact). Classrooms on the roster: Stepping Stones 18 · Primary 62 · Lower Elementary 56 · Upper Elementary 20 · Adolescent 10. If they later split rooms (e.g., Primary North/South — a `primary south` tag exists on 3 contacts), add a per-student **Classroom** dropdown and map it to the `homeroom` role; the filter and hubs key off it with no code.
- **Classroom dashboards** (enrolled-only, program-scoped, no tuition, no Customize; detail = parents, students, authorized pickups, not-authorized, per-student health):
  `/school/VwZSwFD2tkibAXbFZpQm/classroom-stepping-stones`, `classroom-primary`, `classroom-lower-elementary`, `classroom-upper-elementary`, `classroom-adolescent` (append `?chrome=none` for the GHL menu).
- Lesson for onboarding any school moved to field-driven enrollment: grep its `school_dashboards` configs for `enrolled_stage_names` / `enrolled_tag` / `excluded_tag` / `roster_tag_filter` and strip them, or the dashboards silently go empty.
