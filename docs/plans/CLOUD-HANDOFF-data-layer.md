# Cloud → Desktop handoff: enrollment lifecycle + data layer (specs)

*Written across mobile/cloud planning sessions (no DB/GHL creds there). This is a
handoff for the desktop. The deliverables are DECISIONS + four architecture
specs — no code to deploy yet. Branch:
`claude/recent-updates-visibility-rh79by` (docs-only, rebased on latest master).*

## The four specs on this branch (read in this order)

1. **`SELF-ADAPTING-DATA-LAYER.md`** — the foundation. GHL is the source of truth
   for the family/student graph; the app is a synced read model; a living
   field/tag catalog auto-discovers new fields+tags and makes them usable
   columns/filters/conditions; migration maps CSV standard-first
   (propose→review→apply) and writes to GHL; only the core is protected.
2. **`RE-ENROLLMENT-WORKFLOW.md`** — the back of the enrollment lifecycle. The
   annual "roll every family to next year + re-sign them" cycle.
3. **`ADMISSIONS-FUNNEL.md`** — the front of the lifecycle. Inquiry → tour →
   application → decision → enrolled.
4. This handoff.

**How they interlock:** admissions (front) → the convert-to-enrolled seam →
onboarding → re-enrollment (annual), all riding the self-adapting data layer.
Together they let Growth Suite **own the whole enrollment lifecycle** — the
"enrollment growth" wedge — and the payoff number is *admissions' projected new
enrollments + re-enrollment's returning count = total projected next-year
enrollment*, which nothing in the niche produces.

## Decisions Clint locked (don't re-litigate)

1. **GHL is the source of truth for the family/student graph.** Fields created +
   mapped IN GHL; the app DB is a synced read model.
2. **Not for everything** — billing, submissions, attendance, docs, FA stay in
   Supabase (operational); only summary fields write back to the contact.
3. **The reconciling rule:** additions are always safe (auto-discover them);
   only rename/delete of in-use core fields/options is dangerous.
4. **Two hard requirements:** never stray data; schools update ANY data
   themselves without support (incl. adding fields/tags that become usable
   dashboard elements — "day 1 ≠ day 100").
5. **Billing boundary** across all specs: re-enrollment/admissions capture
   intent + signature, NOT payment. Deposits/tuition are the partner's track.

## Build order (safe-in-cloud vs. needs-live-GHL)

Do the safe layers first; gate anything that WRITES to GHL for desktop testing
against a real NON-live sub-account.

- **Data layer P1 — field/tag catalog + discovery** (SAFE). Enumerate fields+tags
  with types each sync, diff for new, persist `school_field_catalog` /
  `school_tag_catalog`. Foundation everything reads from — **start here.**
- **Data layer P2 — dynamic dashboard/form wiring** (SAFE). Catalog → columns /
  filters / sorts / conditions; surface new items.
- **Data layer P3 — mapping engine.** propose/review SAFE; **apply (creates GHL
  fields + writes contacts) NEEDS LIVE TESTING.**
- **Admissions P1 / Re-enrollment P1** — config + read model + funnel/cycle
  surfaces (SAFE; read GHL, write our DB).
- **The convert-to-enrolled seam + GHL writebacks** (both specs) — **write to
  GHL → desktop-test.**
- **Core-edit protection** — hide GHL custom-field settings per school (extend
  CRM menu hiding).

## Reuse map (all of this extends existing code)

Data layer: `run-ghl-sync.ts` (+ catch-all), `ghl/custom-fields-cache.ts`,
`ghl/contacts.ts`, `field-kit.ts`, `apply-intake.ts`, `school_field_schemas`,
Enrollment Hub extra-columns/filters. Admissions: `AdmissionsFunnelStages`
widget, `pipeline-stage-map.ts`, `ghl/pipelines.ts`,
`create-family-from-contact.ts`, `portal_gate_stage`. Re-enrollment: the form
engine + `lib/forms/cosign*`, send-to-families, `EnrollmentTargetsTable`,
the reminder-cron pattern. Full details in each spec.

## Also on the branch (earlier cloud work)

- `docs/onboarding-sop-drafts.md` — Freshdesk help-article drafts for every
  onboarding step.

## Not changed / already live (context)

Security Phase 1, self-serve billing features, the onboarding portal, AI form
import, one-click provisioning, and the onboarding email/reminder layer are
deployed from prior desktop sessions. Outstanding: the auto-mint/embed-token
security migration (do WITH Clint — touches DGM), and testing Google Form import
with a real public form.
