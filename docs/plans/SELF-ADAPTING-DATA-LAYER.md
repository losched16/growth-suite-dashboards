# The Self-Adapting Data Layer on GHL — Architecture Spec

*Planning doc. The blueprint for how school data lives on GHL as the source of
truth, migrates in clean, and stays flexible forever — schools can add fields
and tags and have them become usable columns / filters / conditions
automatically, without ever creating stray data or needing support.*

## The thesis in one line

**GHL owns the family/student graph; the app is a continuously-synced read
model; new fields and tags are auto-discovered and made usable; only the core
that things already depend on is protected.**

---

## 1. Source of truth — the boundary

- **GHL contact records are the source of truth for the family/student GRAPH and
  its attributes** — who the families and students are, and their fields: grade,
  program, schedule, classroom, DOB, allergies, enrollment status, custody,
  contact info, plus any field a school adds later. All contact-graph writes go
  to GHL and only GHL.
- **Supabase is the system of record for OPERATIONAL / TRANSACTIONAL data** that
  is not a contact attribute: billing/invoices, form submissions + signatures,
  attendance events, uploaded documents, financial-aid applications. Only
  *summary* writebacks go to the contact (e.g. tuition amount, admission date).
- **The app DB's copy of the graph is a READ MODEL** — rebuilt from GHL by the
  sync (`lib/sync/run-ghl-sync.ts`), so it can never drift from the truth. It is
  also, usefully, a continuous backup of the graph.

Do **not** force operational data onto GHL contacts (a contact can't hold an
invoice ledger). Do **not** make the app DB the primary for the graph.

---

## 2. Three layers of contact data (this is the key mental model)

| Layer | What | Rule |
|---|---|---|
| **Core** | The ~150 field-kit fields (`lib/onboarding/field-kit.ts`) + the wired vocabularies (Grade Level, Program, Schedule, Homeroom, Enrollment Status) that dashboards, rosters, the parent portal, and form logic already depend on. | **Protected.** Additions to a core picklist are fine; renaming/deleting a core field or an in-use option is the only real danger. |
| **Operational** | Billing, submissions, attendance, documents, FA. | Lives in Supabase. Not on the contact (except summary writebacks). |
| **Discovered** | Any custom field or tag a school adds after day 1. | **Embraced.** Auto-discovered, typed, and made available as a column / filter / sort / condition. |

### The one rule that reconciles "flexible" with "never break"
**Additions are always safe; changes to things already in use are the only
danger.**
- Adding a new field, a new tag, or a new dropdown option → pure capability,
  nothing depends on it yet → **auto-discover and surface it.**
- Renaming/deleting a core field, or renaming/removing an in-use dropdown value
  → **the only thing to protect against** (it silently empties dashboards and
  breaks form logic).

So "new stuff" is never stray data — stray data was duplicate fields ("Grade"
next to the standard grade field) and broken core. Those are prevented at the
front door (import review) and at the core (edit protection), *not* by blocking
additions.

---

## 3. Component A — Migration & field-mapping engine

Turns a school's migration CSV into clean GHL contacts. One engine, reused by
the form-import mapper (same problem: incoming fields → standard GHL fields,
create-if-novel, with review).

**Flow: propose → review → apply.**
1. **Parse** the CSV columns + sample values.
2. **Propose a mapping** for each column, biased hard toward existing standard
   fields:
   - Synonym/alias dictionary first (DOB / Birthdate / Date of Birth → `Student
     N Birth Date`), reusing the roster alias-match already used for form
     prefill.
   - AI for the ambiguous remainder (same call pattern as the FA analysis / form
     import).
   - Output per column: **map to standard field** / **create new field** /
     **ignore**, with a confidence + reason.
3. **Review** (human, in the ops board — or the school for their own data): a
   grid of columns × proposed action, editable, before anything is created or
   written. This is the guardrail against field sprawl.
4. **Apply** — the truth-first write:
   - Create any confirmed new custom fields on the GHL location.
   - Create/update GHL contacts, one per family, mapping each student's columns
     into the correct **student slot** (Student 1–4). Additive writes only —
     never blank an existing value (the "never clear with a blank" rule).
   - **Idempotent + resumable + observable** — GHL is rate-limited and external;
     a silent partial failure would corrupt the source of truth. Track
     per-row status, allow re-run.
5. **Sync** backfills Supabase from GHL as usual → dashboards/portals light up.

**Bonus unification:** the *distinct values* in a picklist column ARE the
intake vocabulary (grades/programs/schedules), so the import auto-populates the
intake→GHL picklist push (`lib/onboarding/apply-intake.ts`) instead of the
school typing them separately.

**Slot cap to accept consciously:** GHL contacts are flat, so the 4-student-slot
pattern caps families at 4 students. Decide this is acceptable (most Montessori
families ≤4) and **detect + warn** on a 5th, rather than fail silently.

---

## 4. Component B — The living field & tag catalog (discovery)

The heart of "flexible on an ongoing basis." Treat the set of fields and tags as
a living thing the system continuously discovers.

- **On every sync** (already runs ~every 15 min), enumerate the location's
  custom fields (`lib/ghl/custom-fields-cache.ts` already fetches these) and all
  tags, each with its **type** (text / number / date / dropdown + its options).
- Persist a per-school **catalog** (new table `school_field_catalog`): field key,
  label, type, options, `first_seen_at`, `last_seen_at`, `is_core`
  (from the field kit), `surfaced` (has the school chosen to use it).
- **Diff each run** → detect **new** fields/tags (and new options on existing
  fields, absorbed into the vocabulary so a re-push never clobbers a school's
  GHL-side addition — vocabulary is GHL-authoritative, not push-once).
- **Type awareness matters** because it determines the filter UI: numbers/dates →
  range filters + sort; dropdowns → multiselect; text → contains. New fields
  arrive with their type from GHL.

---

## 5. Component C — Dynamic dashboards & forms

Everything in the catalog is *usable*; the school picks what's *shown*.

- The **dashboard builder** reads the catalog: any field → **column, filter, or
  sort**; any tag → **filter**. (Extends what exists — the Enrollment Hub can
  already "add any GHL field as an extra column"; roster has
  extra_columns/extra_filters + per-school tag filtering. Make it systematic and
  available on every dashboard.)
- The **form builder** reads the catalog: any field/tag → **conditional-logic
  input** (show/hide a section when grade = X, or when tagged Bus Rider).
- **Discover ≠ auto-display.** New items become *available* + *surfaced as
  suggestions* ("2 new fields, 1 new tag found — add to a dashboard?"), but the
  school chooses what actually shows — otherwise a school with 200 fields gets an
  unusable 200-column table.

### The day-100 experience (concrete)
A school adds a `T-Shirt Size` field and a `Bus Rider` tag in GHL for a field
trip. Next sync, both enter the catalog as new. The school sees "2 new items
available," clicks, adds `T-Shirt Size` as a roster column and `Bus Rider` as a
filter. No support ticket; nothing broke, because it was additive.

---

## 6. Self-serve editing model — "update anything, no support"

| What a school edits | Where | Safe because |
|---|---|---|
| **Values** (a student's grade, a parent's email, allergies, enrollment status) | Family/roster screens (write to GHL) or GHL directly | Changing a value can't create stray data |
| **Vocabulary** (add/rename a grade, program, schedule, classroom) | The Growth Suite intake/settings editor → re-applies to GHL picklists; also absorbs options added in GHL | Guided flow keeps options standardized; GHL-authoritative discovery prevents clobber |
| **New fields / tags** | Add in GHL freely → auto-discovered → choose to surface | Additive; catalog + surfacing make them usable |
| **New custom field at import time** | The mapping review gate | Human confirms before a field is born |
| **Settings/branding/portal** | Self-serve settings page | Already built |

So a school can change **any** of its data itself — structural changes just flow
through a couple of guided surfaces (or are auto-discovered) instead of ad-hoc
core-field surgery.

---

## 7. Guardrails — how each requirement is delivered

**"Never stray data":**
1. One write target (GHL) for the graph → no split-brain.
2. Snapshot-rebuild sync → the read model physically can't drift.
3. Import review gate → no junk fields at the front door.
4. Standard-first + synonym mapping → no five-fields-that-mean-grade.
5. Vocabulary edits go through the guided editor → no `Primary` / `primary ` /
   `PRIMARY` triplets.
6. **Core-edit protection** (below) → the two silent-breakage moves are blocked.

**"Update anything without support":** the table in §6 — values anywhere,
vocabulary + new fields/tags self-serve, everything additive auto-discovered.

**Core-edit protection (the only lock):** hide GHL's *Custom Fields settings*
from school users (extend the existing per-school CRM menu hiding). Schools keep
full freedom on values, vocabulary (via the editor), and adding new fields/tags
— they just can't rename/delete the ~150 core fields or edit in-use options
directly. Optionally, the discovery diff can also **alert** ops if a core field
disappears or an in-use option is renamed, so a break is caught in minutes, not
by a 2am ticket.

---

## 8. What already exists to reuse (this is extension, not net-new)

- `lib/sync/run-ghl-sync.ts` — the sync + the `captureAllContactFieldsForSlot`
  catch-all (already captures unknown fields).
- `lib/ghl/custom-fields-cache.ts` — enumerates location custom fields.
- `lib/ghl/contacts.ts` — contact upsert.
- `lib/onboarding/field-kit.ts` — the ~150 core fields + slot model + `is_core`
  source.
- `lib/onboarding/apply-intake.ts` — the intake→GHL picklist push (vocabulary).
- `school_field_schemas` — the derived role→key mapping.
- Enrollment Hub "add any GHL field as a column"; roster extra_columns /
  extra_filters / tag filter — the seed of dynamic dashboards.
- `scripts/import-enrollment-csv-to-ghl.py` — an existing CSV→GHL path to
  generalize into the mapping engine.

---

## 9. Data-model additions (new; migrations 076+)

- `school_field_catalog` — per-school living catalog (key, label, type, options
  jsonb, is_core, surfaced, first_seen_at, last_seen_at).
- `school_tag_catalog` — per-school tags (tag, first_seen_at, last_seen_at,
  surfaced).
- `field_import_sessions` + `field_import_columns` — the migration mapping
  review state (column → proposed action / confidence / confirmed action /
  applied_at), so import is resumable + auditable.

---

## 10. Build phases (suggested order)

1. **Catalog + discovery** — enumerate fields+tags with types on each sync, diff
   for new items, persist the catalog. (Pure read/write of our own data + GHL
   reads — safe to build and unit-test; no destructive GHL writes.)
2. **Dynamic dashboard/form wiring** — feed the catalog to the builders so any
   field/tag is a column/filter/sort/condition; surface new items.
3. **Mapping engine (propose→review→apply)** — the CSV migration, standard-first
   with AI fallback, review UI, GHL-write apply. **Needs live-GHL testing** (it
   creates fields + writes contacts) — build the propose/review safely, gate the
   apply behind desktop testing against a real sub-account.
4. **Core-edit protection** — hide GHL custom-field settings per school + the
   ops alert on core field/option disappearance.
5. **Unify form-import mapping** onto the same engine.

---

## 11. Open decisions / risks

- **Bulk GHL writes are slow + rate-limited.** The apply step must be
  idempotent/resumable/observable; a one-time migration of hundreds of contacts
  takes minutes, not seconds. Accept it as the price of GHL-is-truth.
- **4-student-slot cap** — decide it's acceptable + warn on the 5th.
- **GHL is a third party** you don't control (API/pricing/roadmap). The sync
  read-model is your backup + portability hedge — keep it.
- **AI mapping needs a human gate** — never auto-create fields from AI guesses;
  the review step is non-negotiable.
- **Vocabulary must be GHL-authoritative** (discover options added in GHL), or a
  re-push will clobber a school's direct addition.
