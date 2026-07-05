# Phase 1 Security — what's DEPLOYED vs STAGED (2026-07-04, autonomous session)

Continues `SECURITY-REMEDIATION-PLAN.md`. Worked with a hard constraint: **do
not impact DGM** (actively collecting forms). So anything provably transparent
to DGM was deployed; the broad sweep that I couldn't click-test against DGM's
embedded admin UI was **staged** on branch `security-phase1` for review.

## ✅ DEPLOYED to production (verified, DGM-safe)

| Item | Repo / commit | Verify |
|---|---|---|
| **H1** — dev login bypass hard-404 in prod (env flags can't reopen it) | portal `aefba73` | `GET /api/dev/login-as-parent` → "not found" |
| **H5** — autopay cron fail-closed (401 if no/`bad CRON_SECRET) | portal `aefba73` | `/api/cron/process-autopay` no-auth → 401 |
| **1.4** — `family-credits` authenticated (was: mark any invoice paid, unauth) | dashboards `39a1b60` | no-cookie POST → 401 |

Earlier in the same day (Phase 0): removed the LIVE `PARENT_DEMO_BYPASS=true`
from portal prod + set `CRON_SECRET`. Both verified.

None of these touch DGM's form-collection path (that's the portal submit route)
or DGM's embedded dashboards. Dev route DGM never calls; cron is Vercel-only;
family-credits uses the same guard as the working `tuition-grids/save`.

## 🟡 STAGED on `security-phase1` (built + typecheck-clean, NOT deployed)

**Why staged, not deployed:** these gate routes/exports that DGM's embedded
**staff/operator** UI calls. The guard (`authorizeOperatorOrSchool`) is
transparent to a valid session, and no cron/webhook hits these routes — but I
can't click-test DGM's embedded admin flows while Clint is away, and a single
surprise caller among 38 routes would 401 a DGM staff action. So: review +
one DGM click-through, then deploy.

- **1.2** (`6f405a2`) — auth added to **38** ungated `/api/admin` routes:
  - 34 `schools/[schoolId]/*` → `authorizeOperatorOrSchool(schoolId)` (operator
    OR matching school session; cross-school → 403). Includes invoice
    void/send/autopay/bulk, payments config/discounts/enrollments/tuition-grids/
    fa-to-discount, connect + connect-oauth/start, refresh-account, roster-import,
    staff, sync-from-ghl, promote-parent2, field-schema, parent-portal-branding/
    forms, portal-menus, provision-defaults, ghl/contact-search, dashboards CRUD,
    forms/duplicate.
  - `schools/create` → operator-only (was fully anonymous).
  - `uploads/[uploadId]/{download,acknowledge,retry}` → resolve school from
    `parent_uploads`, then dual-auth (student PII).
  - `connect-oauth/callback` intentionally left on its HMAC state (now that
    `/start` is gated, valid states only come from authed sessions; per-session
    state binding = follow-up 1.3).
- **1.5** — 6 PII CSV exports (`student-roster, contacts, facts, facts-ledger,
  family-hub, ghl-conflicts`) switched `authorizeExportPublic` →
  `authorizeExport` (session or embed_token required).

### How to deploy the staged branch safely
1. `git fetch && git checkout security-phase1` (or review the PR/diff).
2. Confirm the Vercel **preview** build is green.
3. **DGM click-test on the preview URL** (or right after deploy, watch DGM):
   open DGM's embedded dashboard as staff and exercise: a dashboard edit, a
   payments action (e.g. open Invoices, apply a discount), a roster/sync
   button, a portal-settings save, and a CSV export download. All should work
   (the session cookie carries through). If any 401s, that route's caller
   doesn't include credentials — fix that caller, don't revert the auth.
4. Merge `security-phase1` → master. Roll-back is trivial (revert the 2 commits)
   and safe — it only *removes* auth, never data.

## ⛔ NOT done (needs Clint — highest-risk, can break live embeds)

- **1.1** — remove the `proxy.ts` auto-mint (mints a staff session from a bare
  locationId for the 10/11 schools with `require_staff_login=false`). This is
  THE trust-boundary fix, but removing it **breaks every embedded dashboard**
  unless the GHL menu-link URLs first carry `embed_token` (or GHL-SSO-JWT). The
  code paths already exist (`lib/auth/embed.ts`, the proxy's `embed_token`
  branch); the work is: add `&embed_token=…` to each school's GHL menu links,
  verify each embed still loads, THEN remove auto-mint. Requires touching DGM's
  GHL menu links → do it with Clint present.
- **MCH `require_staff_login=true`** — same dependency (wire embed tokens first,
  MCH has 0 staff-login rows → flipping blind locks them out).
