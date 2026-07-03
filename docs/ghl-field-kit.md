# Growth Suite — GHL Field Kit

The canonical custom-field set a location needs for the platform to work end
to end. Maintain ONE template location in GHL containing exactly this, save it
as a **snapshot**, and import the snapshot into every new school's location —
every field name, type, and picklist lands correctly with zero manual setup.

The `/admin/{schoolId}/field-audit` page is the executable version of this
contract: run it after connecting any location to verify.

## Philosophy

- **Structure is standardized** — field keys, types, and the Enrollment
  Status picklist are identical for every school.
- **Values are the school's own** — grade names, classroom/homeroom names,
  program names, and tags differ per school. Collect their vocabulary at
  intake and fill the picklists accordingly; dashboards, form targeting, and
  classroom hubs read whatever the contacts carry.

## Per-student fields (repeat for slots 1–4)

Create each field 4× with keys `student_1_<base>` … `student_4_<base>`.
(The sync also accepts bare `student_<base>` for slot 1, but the numbered
form is the standard for new schools.)

| Field key (per slot) | Type | Notes |
|---|---|---|
| `student_N_first_name` | TEXT | **Required — students cannot sync without it** |
| `student_N_last_name` | TEXT | Falls back to parent's last name if blank |
| `student_N_enrollment_status` | SINGLE_OPTIONS | **Required — the roster keys off this.** Picklist: `Enrolled`, `Pending`, `Accepted`, `Waitlisted`, `Withdrawn`, `Declined`. No free text, no "Unknown". |
| `student_N_birth_date` | DATE | Ages, birthday views |
| `student_N_grade_level` | SINGLE_OPTIONS | **Picklist values = the school's own grade names** (intake) |
| `student_N_program_name` | SINGLE_OPTIONS | The school's program names (intake) |
| `student_N_homeroom` | SINGLE_OPTIONS | **Picklist values = the school's classroom names** (intake) — drives classroom hubs |
| `student_N_lead_teacher` | TEXT | Shown on rosters/classroom hubs |
| `student_N_daily_schedule` | SINGLE_OPTIONS | e.g. Half Day / School Day / Extended Day (school's terms) |
| `student_N_student_id` | TEXT | Auto-fillable by the platform (Settings → auto Student IDs) |
| `student_N_gender` | SINGLE_OPTIONS | Optional |
| `student_N_allergies` | LARGE_TEXT | Roster allergy views |
| `student_N_enrollment_start_date` | DATE | Proration / start tracking |
| `student_N_student_street` / `_city` / `_state` / `_zip` | TEXT | Family address (prefill + teacher mailing info) |
| `student_N_ethnicity` | SINGLE_OPTIONS | Optional (forms prefill/writeback) |
| `student_N_physical_custody` / `_legal_authority` (+ `_oth` variants) | SINGLE_OPTIONS / TEXT | Enrollment agreement custody + co-sign routing |

Money fields (optional — used by Finance dashboard + enrollment writeback):
`student_N_annual_tuition`, `student_N_extended_day`, `student_N_organic_lunch`
(+ `_choice` SINGLE_OPTIONS variants), `student_N_payment_plan`,
`student_N_enrollment_fee`, `student_N_administrative_fee`,
`student_N_sibling_discount`, `student_N_total_charges`, `student_N_net_charges`
— all MONETORY except the `_choice` picklists.

## Parent 2 fields (contact-level, once)

| Field key | Type |
|---|---|
| `parent_2_first_name`, `parent_2_last_name` | TEXT |
| `parent_2_email` | TEXT |
| `parent_2_mobile` | PHONE |
| `parent_2_relationship` | TEXT |
| `parent_2_address`, `parent_2_city`, `parent_2_state`, `parent_2_zip` | TEXT |
| `parent_2_employer_name`, `parent_2_position` | TEXT |
| `parent_1_relationship`, `parent_1_employer_name`, `parent_1_position` | TEXT |

Powers: second-guardian prefill + writeback, enrollment co-signature routing,
and Parent-2 marketing-contact creation.

## Reserved tags (do not repurpose)

| Tag | Platform meaning |
|---|---|
| `parent 1` | This contact is a family's primary record |
| `parent 2` | Marketing-only co-parent contact (skipped from rostering **unless also tagged `parent 1`** — split households carry both) |
| `withdrawn` | With a roster tag filter: keep the family, mark students withdrawn |

Schools may add any other tags freely — form targeting and roster filters can
use them.

## Pipeline (recommended)

An admissions pipeline whose stage names the school chooses. Two integrations
key off stage names (both configurable per school in Settings — no fixed
naming):
- **Portal access gate** — the stage that unlocks parent account creation.
- **Prospective-family funnel** — stages map to inquiry/tour/applied/accepted.

## Intake checklist (per school — their vocabulary)

1. Grade names → `student_N_grade_level` picklist values
2. Classroom/homeroom names → `student_N_homeroom` picklist values
3. Program names → `student_N_program_name` picklist values
4. Schedule tier names → `student_N_daily_schedule` picklist values
5. Any roster tags they use (e.g. an enrolling-class tag) → Settings → roster tag filter
6. Which pipeline stage should unlock portal access → Settings → portal gate stage
7. Academic year → Settings (also asked at school creation)
