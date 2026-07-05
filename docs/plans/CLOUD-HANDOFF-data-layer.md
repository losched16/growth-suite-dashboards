# Cloud → Desktop handoff: the self-adapting data layer

*Written in a mobile/cloud planning session (no DB/GHL creds there). This is a
handoff for the desktop session. The deliverable is a decision + a full
architecture spec — no code to deploy yet.*

## What this session produced

A long design conversation with Clint about how school data should live on GHL,
migrate in clean, and stay flexible forever — resolved into one blueprint:

➡️ **Read `docs/plans/SELF-ADAPTING-DATA-LAYER.md`** — the full architecture
spec. Everything below is the short version + what to build next.

Branch: `claude/recent-updates-visibility-rh79by` (docs-only this session,
rebased on latest master). Nothing to deploy — it's a plan.

## The decisions Clint locked (don't re-litigate these)

1. **GHL is the source of truth for the family/student graph.** Fields are
   created and mapped IN GHL. The app DB is a synced read model (rebuilt by
   `lib/sync/run-ghl-sync.ts`), never the primary for contact data.
2. **But not for everything.** Billing, form submissions, attendance, documents,
   FA are operational/transactional → they stay in Supabase; only summary
   fields (tuition amount, admission date) write back to the contact. Don't
   force those onto GHL.
3. **The reconciling rule:** *additions are always safe; only changes to things
   already in use are dangerous.* A new field/tag/option = pure capability,
   auto-discover it. Renaming/deleting a core field or an in-use dropdown value
   = the only real danger (silent — empties dashboards, breaks form logic).
4. **Two hard requirements from Clint, both non-negotiable:**
   - **Never stray data** (no field sprawl, no duplicates, no broken core).
   - **Schools can update ANY of their data themselves, without contacting
     support** — including, explicitly, adding new fields/tags that then become
     usable dashboard columns / filters / conditional-logic inputs on an ongoing
     basis ("day 1 ≠ day 100").
5. **How both are delivered together:** clean at the front door (import review
   gate), protected at the core (hide GHL's custom-field settings per school so
   the two silent-breakage moves are impossible), and wide-open + auto-adapting
   everywhere else (a living field/tag catalog feeds the dashboards/forms).

## The architecture in three components

- **A. Migration & field-mapping engine** — CSV → propose mapping (standard
  fields first via synonyms, AI for the rest) → **human review** → apply:
  create confirmed new fields + write contacts to GHL (slot-aware, additive,
  idempotent/resumable). Same engine reused for form import. Distinct picklist
  values in a column auto-populate the intake vocabularies.
- **B. Living field & tag catalog** — on every sync, enumerate all custom fields
  (with types) + all tags, persist a per-school catalog, diff for new items.
  Vocabulary becomes GHL-authoritative (absorb options added directly in GHL so
  a re-push never clobbers them).
- **C. Dynamic dashboards & forms** — the catalog feeds the builders: any field
  → column/filter/sort, any tag → filter, any field/tag → form condition. New
  items are *surfaced as suggestions* ("2 new fields found — add to a
  dashboard?"), but discover ≠ auto-display (the school picks what shows).

## What to build next (order + safety)

From the spec's phase list — **build these in a cloud session safely; gate the
GHL-writing one for the desktop:**

1. **Catalog + discovery (SAFE to build anywhere).** Enumerate fields+tags with
   types each sync, diff for new items, persist `school_field_catalog` /
   `school_tag_catalog`. Reads GHL + writes our own DB only — no destructive GHL
   writes. This is the foundation everything reads from; recommend starting here.
2. **Dynamic dashboard/form wiring (SAFE).** Feed the catalog to the builders;
   surface new items.
3. **Mapping engine — propose/review SAFE, apply NEEDS LIVE GHL TESTING.** The
   apply step creates GHL fields + writes contacts, so test it against a real
   NON-live sub-account on the desktop before trusting. Build propose+review in
   cloud; run apply on desktop.
4. **Core-edit protection** — hide GHL custom-field settings per school (extend
   the existing CRM menu-hiding); optional ops alert when a core field/option
   disappears.
5. **Unify form-import mapping** onto the same engine.

## Reuse map (this extends existing code, not net-new)

`lib/sync/run-ghl-sync.ts` (sync + `captureAllContactFieldsForSlot` catch-all),
`lib/ghl/custom-fields-cache.ts` (field enumeration), `lib/ghl/contacts.ts`
(upsert), `lib/onboarding/field-kit.ts` (core fields + `is_core`),
`lib/onboarding/apply-intake.ts` (vocabulary push), `school_field_schemas`
(role→key), Enrollment Hub "add any GHL field as a column" + roster
extra_columns/extra_filters/tag-filter (seed of dynamic dashboards),
`scripts/import-enrollment-csv-to-ghl.py` (CSV→GHL path to generalize).

## Also on the branch from recent cloud sessions

- `docs/onboarding-sop-drafts.md` — first-draft Freshdesk help articles for every
  onboarding step (source content for the "Help & Guides" menu item).

## Not changed / already live (context)

Security Phase 1, the self-serve billing features, the onboarding portal, AI
form import, one-click provisioning, and the onboarding email/reminder layer are
already deployed from prior desktop sessions. Outstanding from the last desktop
snapshot: the auto-mint/embed-token security migration (do WITH Clint — touches
DGM), and testing the Google Form import with a real public form.
