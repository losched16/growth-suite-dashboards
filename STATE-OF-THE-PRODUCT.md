# Growth Suite Dashboards — State of the Product

**Last updated:** 2026-05-23
**Purpose of this doc:** The starting point for any new Claude Code session.
Read this FIRST before touching code so you know what's live, what's
multi-tenant, what's still hardcoded to a specific school, and what's
deferred.

---

## What this repo IS

The staff-facing operator dashboard for Growth Suite — a multi-tenant SaaS
serving K-12 private schools. Built on Next.js 16 App Router, Postgres
(Supabase), deployed to Vercel.

Schools see this when they log in. It contains:

- **Enrollment Hub** — student roster + breakdowns by program / grade level
- **Family Hub** — per-family detail accordion with parents, students,
  pickup permissions, health profiles, tuition
- **Payments Dashboard** — KPIs, financial-aid queue
- **Per-classroom dashboards** — auto-provisioned per teacher
- **GHL sync** — pulls contacts/students from each school's GHL location

## Currently live schools

| School | Slug / Notes |
|---|---|
| Montessori School of Wooster | school_id `2c944223-b2ad-45e1-8ba4-a4b616e4c29a`, GHL location `tFP5UnlBYQayjettNeuG` |
| Desert Garden Montessori (DGM) | (look up in `schools` table — was the original pilot) |

## Architecture overview

```
                  ┌──────────────────────────┐
                  │   growth-suite-dashboards │ (this repo — staff side)
                  └──────────┬────────────────┘
                             │
                             ▼
        ┌────────────────────────────────────────────┐
        │   Supabase Postgres (single shared DB)      │
        │   Every table keyed by school_id            │
        └────────────────────────────────────────────┘
                             ▲
                             │
                  ┌──────────┴────────────────┐
                  │  growth-suite-parent-portal │ (separate repo — parent side)
                  └──────────────────────────┘

         growth-suite-family-graph (separate service, called via FAMILY_GRAPH_URL)
```

## Multi-tenant readiness — subsystem by subsystem

| Subsystem | Multi-tenant ready? | Notes |
|---|---|---|
| Database schema | ✅ Yes | Every table keyed by `school_id`, tenant root is `schools` table |
| Widget framework (`lib/widgets/`) | ✅ Yes | All widgets accept `SchoolContext`, fully school-scoped |
| Enrollment Hub widget | ✅ Yes | Has `only_enrolled` config flag (Wooster needs it) |
| Family Hub accordion | ✅ Yes | Already generic |
| Student Roster + DocumentsCell | ✅ Yes | Already generic |
| Form schema renderer | ✅ Yes | Fully data-driven from `portal_form_definitions.field_schema` jsonb |
| Per-school field-key mapping | ⚠️ Partial | `lib/sync/desert-garden-config.ts` is hardcoded per school. Needs a `school_field_schemas` table (migration 004 exists but underused) |
| GHL sync | ❌ No | `scripts/sync-wooster-from-ghl.mjs` is hardcoded with school UUID + tag + field IDs. Needs to become a generic `GhlSchoolSync` class |
| Dashboard provisioning | ❌ No | Per-school scripts (`provision-wooster-*.mjs`, `provision-dg-*.mjs`). Needs templates |
| Form seeding | ❌ No | `seed-wooster-portal-forms.mjs` + `seed-dgm-enrollment.mjs`. Needs a template library |
| Payment system | ❌ No | Stripe Connect per-school. Plan is to migrate to GHL native payments |
| Per-school branding | ⚠️ Partial | `--brand` CSS variable exists, but no admin UI to set it |
| Custom domain | ❌ No | Single Vercel domain today |

## Key files & where things live

```
app/
  admin/[schoolId]/           — school admin UI
  api/                        — server endpoints
  school/[locationId]/        — public widget rendering (chrome=none embeddable)

lib/
  widgets/                    — widget framework
    components/               — each widget is a folder (index.tsx, fetcher.ts, config.ts)
  sync/                       — GHL sync logic
    desert-garden-config.ts   — ⚠ DGM-specific hardcoded config (multi-tenant gap)
    run-ghl-sync.ts           — sync orchestrator
  family-graph/client.ts      — HTTP client for the family-graph service
  ghl/                        — GHL API clients
  dashboards/registry.ts      — dashboard template registry

migrations/                   — 32 SQL files, numbered
  034_parent_privacy.sql      — most recent (2026-05-22)
  035_parent_student_assignments.sql

scripts/                      — provisioning + data import (40+ files)
  sync-wooster-from-ghl.mjs   — ⚠ hardcoded, must generalize
  import-wooster-*            — one-off Wooster data import (don't generalize)
  import-dgm-*                — one-off DGM data import (don't generalize)
  provision-*-dashboard.mjs   — per-school dashboard provisioning (must generalize)
  seed-*-portal-forms.mjs     — per-school form seeding (must generalize)
```

## Environment / deployment

**Vercel project:** `growth-suite-dashboards`
**Live URL:** `growth-suite-dashboards.vercel.app`
**Custom domain:** none yet
**Deploy:** `npx vercel --prod --yes` (manual — to be replaced by GitHub auto-deploy)

**Required env vars (see `.env.local.example`):**
- `DATABASE_URL` — Supabase Postgres (shared with parent-portal + family-graph)
- `ENCRYPTION_KEY` — for encrypting/decrypting GHL PITs in DB
- `INTERNAL_API_TOKEN` — for service-to-service auth between dashboards / family-graph / parent-portal
- `FAMILY_GRAPH_URL` — URL of the family-graph service
- `GHL_LOGIN_SECRET` — for parent-portal magic-link generation
- `CRM_APP_BASE` — defaults to `https://app.mygrowthsuite.com` for "Open in GHL" deep links

## What's in the database (table-level)

Key tables:
- `schools` — tenant root
- `families`, `parents`, `students`, `enrollments`, `classrooms` — family graph
- `parent_student_assignments` (new) — many-to-many for blended families
- `portal_form_definitions`, `portal_form_submissions` — forms
- `student_health_profiles` — medical info
- `pickup_persons`, `student_pickup_restrictions` — pickup permissions
- `attendance_events`, `daily_attendance` — attendance check-in/out
- `invoices`, `invoice_line_items`, `payment_methods`, `payment_attempts` — billing
- `fa_applications` — financial aid
- `school_dashboards` — per-school dashboard layout (JSONB)
- `school_field_schemas` — per-school GHL field mapping (underused, needs to become source of truth)

## Things to know before changing anything

1. **The dashboards repo has 32 migrations** in `migrations/`. New schema changes go in a new numbered file.
2. **The GHL sync writes to a SHARED `students` table** — sibling slot-1/slot-2/slot-3 records all live there, with `metadata.slot` distinguishing them.
3. **GHL PITs are encrypted at rest** — see `lib/ghl/client.ts` for decryption pattern.
4. **There's a separate `growth-suite-family-graph` service** that this repo calls into via `FAMILY_GRAPH_URL`. Not deprecated — actively used.

## Multi-tenant build — what comes next

See the kickoff brief paste in the new Claude Code session. Top 3 pain points
in priority order:

1. **Form template library + builder UI** — replace per-school seed scripts
2. **Custom field discovery + AI-assisted GHL field mapping** — replace hardcoded field IDs
3. **GHL native payment integration** — replace Stripe Connect per-school

Phase 1 starting point: generalize `scripts/sync-wooster-from-ghl.mjs` into
a config-driven `GhlSchoolSync` class. Highest leverage — every new school
onboarding flows through this.

## What NOT to touch

- `scripts/import-wooster-*` and `scripts/import-dgm-*` — one-off data imports,
  don't try to make generic. Archive after the dust settles.
- The Wooster + DGM Stripe Connect setups — grandfather these until payments
  migration is planned (open architectural decision).
