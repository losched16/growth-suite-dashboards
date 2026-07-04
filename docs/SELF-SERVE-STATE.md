# Self-Serve Platform — State of the Project

*Last updated: 2026-07-02 (end of a large build day). This doc exists so any
session — including mobile planning sessions — can pick up exactly where we
left off. Planning can happen anywhere; deployment happens from the desktop
environment (it holds the DB credentials and GHL tokens; none are in this
repo).*

## The mission (Clint, verbatim intent)

Make the entire platform self-serve for ANY school: no per-school data
carryover, no FACTS-or-not assumptions, no per-school code. A new school can
set up the portal + settings, toggle portal parts on/off, create forms with
conditional logic, enroll students, set up tuition, and build dashboards
(prebuilt templates + custom from any GHL data). **The GHL contact record is
the source of truth for everything.**

Two products, one platform:
- **Admissions/portal product** — dashboards, rosters, parent portal, forms,
  tuition (this doc's focus)
- **DFY marketing product** — see `sop-marketing-client-onboarding.md`
  (separate SOP; no dashboards/rosters involved)

## Standing constraints (do not violate)

1. **Never write to existing schools' data** (especially DGM
   `005c2872-dd27-4c43-9b3c-5fd353b8db44`) during platform work — additive
   code only, new-school paths only. Existing setups are live and signed-off.
2. **Standardize STRUCTURE, not VALUES** — field keys/types/status picklists
   are identical for every school; grade/classroom/program NAMES are each
   school's own vocabulary, collected at intake.
3. **Enrollment status comes purely from the GHL contact field.** No
   assumptions, no defaults. Blank/unrecognized → the student appears in no
   roster until the school fixes the contact.
4. Parent-facing surfaces never say "GHL"/"GoHighLevel" — it's Growth Suite.

## Architecture in one paragraph

Two repos share one Postgres (Supabase): `growth-suite-dashboards`
(operator + school-facing admin, sync engine, widgets) and
`growth-suite-parent-portal` (parent-facing portal). Both auto-deploy to
Vercel on push to master. The sync (`lib/sync/run-ghl-sync.ts`) is a
15-minute full-snapshot rebuild per school (DELETE+reinsert, ids preserved,
passwords stashed/restored) + a real-time contact webhook path. Per-school
behavior lives in `schools.settings` (jsonb) — see `lib/school-settings.ts`
(same helper mirrored in both repos).

## What shipped in the self-serve sprint (2026-07-01 → 02)

| Piece | Where | Commits |
|---|---|---|
| `schools.settings` bag killed ALL per-school hardcodes (academic_year, portal_gate_stage, auto_student_ids, promote_parent2, roster_tag_filter) | migration 071, `lib/school-settings.ts`, sync libs, cron | dash `1f72d0e`, portal `440d97c` |
| School Settings page: "School & sync settings" section (all of the above, self-serve) | `app/school/[locationId]/settings/page.tsx` + `/api/school/[locationId]/school-settings` | same |
| Dashboard template gallery ("Add dashboard" in school nav): Family Hub, Student Roster, Enrollment Hub, Finance, Rosters Hub, Portal Forms, Document Tracker + **classroom-hubs generator** (one enrolled-only teacher dashboard per classroom, re-runnable) | `lib/dashboards/templates.ts`, `/school/[loc]/dashboards/new`, `/api/school/[loc]/dashboards/from-template` | `1f72d0e` |
| Form template library (6 generic starters: pickup auth, medication consent, photo release, field trip, emergency/medical w/ health-profile round-trip, blank consent) → drafts that open in the v2 builder | `lib/forms/templates.ts`, `/api/school/[loc]/forms/from-template`, forms/new page | `13cf66d` |
| GHL **field audit** (executable field contract: slots, required bases, Enrollment Status picklist + rogue values, parent_2 set, reserved tags, intake items) | `lib/onboarding/field-audit.ts`, `/admin/[schoolId]/field-audit` | `d828643` |
| **Field Kit** as code + API provisioning script (150 fields, folders, picklists, reserved tags into a fresh location; idempotent) | `lib/onboarding/field-kit.ts`, `scripts/provision-field-kit.ts`, `docs/ghl-field-kit.md` | `1d37963` |
| Onboarding fix: create-school now derives + stores the field schema from the location's real fields (`householdId: ''` explicit when no household field — see gotcha below) | `app/api/admin/schools/create/route.ts` | `9c6d860` |
| CRM sidebar menu hiding per sub-account (platform side done; GHL snippet **parked**) | `/api/ghl-menu-config/[locationId]`, settings checkboxes, `docs/ghl-menu-snippet.js` | `44ec891` |
| Marketing onboarding SOP + client expectations doc | `docs/sop-marketing-client-onboarding.md`, `docs/marketing-client-expectations.md` | `893f966` |

### Earlier same-day platform wins (context)
- v2 drag-and-drop form builder finished: dnd-kit, GHL field mapping with
  prefill alias-matching, conditional logic editor, inline live preview,
  who-sees-this-form targeting, built-in record prefill sources.
- Sync robustness: deleted-contact orphan guard; Parent-2 marketing contacts
  skipped from rostering **unless also tagged `parent 1`** (split households);
  strict enrollment status; GHL writeback fixed for prod (Vercel `after()`)
  incl. cost fields; per-sub-account roster tag filter.

## The GS Test School (the future snapshot template)

Built 2026-07-02 entirely via API as the new-school dry run:
- GHL sub-account **"GS Test School (Template Build)"**, location
  `YmLinBRSvCUgB6unrX0g` (created via Clint's agency token — agency PIT CAN
  create sub-accounts; CANNOT create custom fields or read snapshots)
- Field Kit provisioned: 150 fields + `parent 1`/`parent 2`/`withdrawn` tags
  — field audit ALL GREEN, 4 slots
- Onboarded as school `758b1a73-bfa8-4f9c-aed8-f7e7a61d9180` (snapshot sync
  mode, starter dashboards, settings)
- Test family proven end-to-end: contact w/ 2 kids → Tester Family, Sunny
  **enrolled** @ Room A, Stormy **pending**, Sam as co-parent
- A stub email template "GS Probe Template" exists (proved POST
  /emails/builder works — email templates CAN be created via API)

**To finish the template (Clint, in GHL UI):** add the admissions pipeline
(e.g. Inquiry → Pending → Offer Accepted → Enrolled), optionally the standard
workflows + real email templates, then **save the sub-account as a GHL
snapshot**. Future school = create sub-account from snapshot (API-able) →
location PIT → Add school → intake vocab → done. Pipelines/workflows/PITs are
UI-only (no create API); snapshots carry pipelines, workflows, and email
templates.

## Gotchas worth remembering (hard-won today)

- **Schema loader merges the DG preset underneath saved rows** — a school
  opts OUT of household gating only via an explicit `householdId: ""` in its
  school_field_schemas row (absence gets resurrected by the merge). The
  create-school flow now stores this automatically.
- **GHL contact search is eventually consistent** — a just-created contact
  can take ~30–60s to appear in the sync's search.
- **Fire-and-forget promises die on Vercel** — anything that must run after
  the response needs `after()` from next/server (this silently killed GHL
  writeback for a day).
- **Local syncs vs prod cron**: running the sync locally with new code while
  prod cron runs old code = prod undoes your work every 15 min. Deploy
  first, then sync.
- Watch for a stuck `idle in transaction` session blocking syncs
  (pg_terminate_backend it).

## Open items (the working roadmap, in rough priority)

1. **Finish GS Test walkthrough**: seed a template form + Room A classroom
   hub; Clint adds pipeline; snapshot it → becomes THE template.
2. **Tuition setup audit** (was mid-flight when interrupted): schools CAN
   create tuition grids (`Grids.tsx` → `/api/school/tuition-grids/save`) and
   plan templates (Plans tab → dual-auth admin endpoint). Remaining: walk the
   full flow as a school user and close any operator-only gaps (e.g. verify
   discounts/catalog tabs, grid → enrollment agreement wiring for a new
   school with no DGM-style form).
3. **"Any GHL data" dashboards**: roster already has extra_columns +
   extra_filters + a roster-settings builder; EnrollmentHub lacks
   arbitrary-field FILTERS and CSV extra columns; consider a "blank + pick
   your fields" gallery template.
4. **Onboarding wizard**: stitch create-school → field audit → (optional
   field-kit push for snapshotless locations) → first sync → gallery into
   one guided flow. Optional: "create missing fields" button on the audit
   page (API supports it).
5. **Parked — CRM menu hiding**: platform side works (config endpoint
   serving GS Test's saved hides verified); the agency Custom JS snippet
   errored on install (suspect: pasted into Custom CSS, or newline-stripping
   killed `//` comments; a single-line variant exists in the SOP chat but is
   untested). Resume = 10-min debug on the white-label domain.
6. **Marketing SOP blanks**: snapshot name, intake form link, Tim Seldin
   scheduling link, quiz code location, blog library location — Clint to fill.
7. DGM-side (separate from self-serve, when Clint says go): 15 real students
   still carry "unknown" enrollment status on their contacts; test
   enrollment sends to Kim & Leslie / Monica Finch pending.

## How to work on this from a phone

Plan against this doc + the code. Don't run DB/GHL scripts from cloud
sessions (no credentials there, by design). Write plans as markdown into
`docs/plans/` or as issues; the desktop session picks them up and executes
deploys. Key entry points for code reading:
`lib/school-settings.ts` · `lib/sync/run-ghl-sync.ts` ·
`lib/dashboards/templates.ts` · `lib/forms/templates.ts` ·
`lib/onboarding/field-kit.ts` + `field-audit.ts` ·
`app/school/[locationId]/settings/page.tsx` · `docs/ghl-field-kit.md`
