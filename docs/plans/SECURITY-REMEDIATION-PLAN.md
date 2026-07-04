# Security Remediation Plan — Tuition / Billing / Financial-Aid

*Author: security review session, 2026-07-04. Status: PROPOSED — not yet
executed. This is a planning doc (per `docs/SELF-SERVE-STATE.md`, plans live
here and the **desktop** session executes deploys; this cloud session has no
DB/GHL/Stripe credentials). Nothing in this plan has been applied to code.*

## Why this exists

We are preparing to sell the tuition/billing product under a partner brand
(Montessori Compass). A four-part security review of both repos
(`growth-suite-dashboards` + `growth-suite-parent-portal`) found that the
**payment mechanics are sound** but the **authorization layer on the staff
side is broken**: a school's entire back office (including financial-aid tax
documents) unlocks from a semi-public GHL `locationId`, ~44 of 56 admin API
routes have no auth, one endpoint marks invoices paid with no auth, and
full-school CSV exports are public.

None of these are money-theft vectors (funds settle to each school's own
Stripe, cards are tokenized) — they are **data-breach and data-integrity**
vectors. For a financial product holding children's + family financial data
under someone else's brand, they are disqualifying until fixed. The good news:
they are a consistent *pattern of missing checks*, not architectural rot, and
the fixes are focused and estimable.

**Verified findings** (read against source, corroborated by ≥2 independent
reviewers): the auto-mint trust boundary (`proxy.ts:167-216`), the ungated
admin routes (grep: 44/56 route files call no auth helper), and
`family-credits` marking invoices paid unauthenticated
(`app/api/school/family-credits/route.ts:41-46`).

## Standing constraints (from SELF-SERVE-STATE.md — do not violate)

1. **Never write to existing schools' data.** These fixes are additive /
   auth-hardening only. Do not migrate or mutate DGM
   (`005c2872-dd27-4c43-9b3c-5fd353b8db44`) or any live tenant's rows.
2. **The GHL cross-site iframe constraint is real.** The credential-free
   auto-mint was introduced to keep embedded dashboards working when browsers
   drop partitioned (CHIPS) cookies inside the GHL iframe. Any fix to the
   trust boundary MUST preserve the embedded experience or it breaks every
   live school. See Phase 1.1 for the migration path that does both.
3. **Deploy before sync/testing against prod.** Prod cron runs old code every
   15 min; local changes get overwritten. Deploy first.

## How to sequence this

- **Phase 0** — confirm the three runtime facts that set severity (½ day).
- **Phase 1 (CRITICAL, pre-sale blocker)** — close the trust boundary, gate
  the admin routes, kill the public exports and demo bypass. This is the line
  between "actively unsafe" and "defensible." ~1–2 weeks.
- **Phase 2 (HIGH)** — rate limiting, cron fail-closed, token hardening.
  ~1 week.
- **Phase 3 (STRUCTURAL, enterprise-review readiness)** — staff roles, RLS,
  encryption at rest, audit log. ~2–4 weeks.
- **Phase 4 (COMPLIANCE/paperwork)** — subprocessor disclosure, DPA, pen test.
  Parallel track, mostly non-code.

Each item below has: what/why, the exact files, the fix, and how to verify.

---

## Phase 0 — Confirm runtime facts (do first; sets severity)

These three facts are not knowable from code alone and change how urgent some
items are. Confirm from Vercel env + a DB query before starting.

- [ ] **`require_staff_login` distribution.** Query: how many live schools
  have `require_staff_login = false` (the legacy auto-mint default)?
  `SELECT require_staff_login, count(*) FROM schools GROUP BY 1;` Every
  `false` tenant is fully exposed by the C1 auto-mint. This tells you the
  real blast radius today.
- [ ] **`PARENT_DEMO_BYPASS` and `DEV_AUTH_BYPASS`** — are either set in the
  **production** Vercel env for either project? If `PARENT_DEMO_BYPASS=true`
  is set in prod, that is an active full-account-takeover backdoor (H1) —
  unset it *today*, before the rest of this plan.
- [ ] **`CRON_SECRET`** — is it set in the parent-portal prod env? If unset,
  the autopay cron is publicly triggerable (H5). Confirm it's set.

---

## Phase 1 — CRITICAL (pre-sale blockers)

### 1.1 Close the trust boundary: stop auto-minting a session from `locationId`

**Finding (C1).** `proxy.ts:167-216` (`guardSchool`): any request to
`/school/{locationId}/…` with no valid cookie, for a school where
`require_staff_login` is false, mints a full 8-hour staff session from the URL
alone — no credential. `locationId`s are semi-public (they appear in embed
URLs, browser history, and two are hardcoded at `proxy.ts:333-338`). The
`embed_token` branch (`proxy.ts:231`) and `dev_token` branch (`:270`) are
currently **dead code** because auto-mint returns first. This is the root
failure everything else inherits.

**The constraint that makes this non-trivial:** the auto-mint exists so the
GHL iframe keeps working when Chrome/Safari drop the partitioned cookie. We
cannot simply delete it and require a login — that breaks every embedded
school. We must give the iframe a *real* credential to present on every load.

**Fix — migrate the iframe to a real per-load credential, then remove
auto-mint.** Two mechanisms already exist in the codebase; use them:

1. **Preferred: GHL SSO JWT via `ghl-exchange`.** GHL custom menu links / custom
   pages can pass GHL's signed user JWT. `app/api/auth/ghl-exchange/route.ts`
   already verifies it (`lib/auth/school.ts:55`) and mints a session. Make the
   GHL menu links land on a page that carries that JWT and exchanges it. This
   is *per-user* (best — real identity for the audit log in 3.4).
   - Also harden the verify (finding H4): enforce `exp`, and check `aud`/`iss`
     in `verifyGhlToken` (`lib/auth/school.ts:55-58`). Reject tokens without
     an expiry.
2. **Bridge / fallback: per-school `embed_token`.** `lib/auth/embed.ts` already
   derives `HMAC(EMBED_TOKEN_SECRET, locationId)` and `checkEmbedToken` is
   timing-safe. This is a real secret (unlike the bare `locationId`). Update
   each school's GHL Custom Menu Link URLs to include
   `&embed_token=<deriveEmbedToken(locationId)>`. The existing (currently
   dead) `embed_token` branch then takes over.
   - Note: `embed_token` is per-school, not per-user — it's a shared bearer.
     Acceptable as a bridge; the GHL SSO JWT is the target for real per-user
     identity.

**Then, in `proxy.ts` `guardSchool`:**
- [ ] Delete the credential-free auto-mint block (`proxy.ts:167-216`). Keep:
  valid existing cookie (`:140-147`), operator cookie, `embed_token`
  (`:231-266`), GHL-exchange path, and the `require_staff_login` → `/staff`
  redirect (`:185-193`).
- [ ] Requests with no valid credential get the 401 (`:309-312`) — which is
  what `next.config.ts:5-12` already *claims* happens.
- [ ] Remove the two hardcoded production `locationId`s from
  `FORCE_NO_CHROME_LOCATIONS` (`proxy.ts:333-338`) — move to a DB column or
  the settings bag; don't ship real tenant IDs in source.

**Rollout (avoid breaking live embeds):**
1. Ship the `embed_token`/exchange support first (additive, both paths live).
2. Update every live school's GHL menu-link URLs to carry the credential.
   Verify each embed still loads.
3. *Then* remove the auto-mint in a follow-up deploy.
4. Set `require_staff_login = true` (or the embed-token requirement) as the
   default for all new schools in the create flow.

**Verify:** `curl -sS https://<host>/school/<locationId>/payments` with no
cookie and no token → 401 (today: 200 + a minted session). Embedded load
through GHL with the updated menu link → still works.

### 1.2 Gate every `/api/admin/*` route

**Finding (C2).** The proxy gates the `/admin/*` and `/school/*` *page*
prefixes but not `/api/admin/*` (the `proxy()` body checks
`startsWith('/admin/')`, which does not match `/api/admin/`; `proxy.ts:49-54`).
Handlers were expected to self-auth; a grep shows **44 of 56**
`app/api/admin/**/route.ts` files call no auth helper
(`authorizeOperatorOrSchool` / `requireOperator` / `verifySchoolSession` /
`checkServiceAuth`). Several contain comments *claiming* proxy/cookie auth that
does not exist (`sync-from-ghl/route.ts:15`, `roster-import`, `connect`).
`app/api/admin/schools/create/route.ts` needs no `schoolId` and is fully
anonymous — anyone can create a school.

**Fix — defense in depth, do both layers:**

- [ ] **Layer 1 (belt): fix the proxy** so `/api/admin/*` is not a free pass.
  Add an operator-or-dual gate for `/api/admin` in `proxy()`. Simplest:
  treat `/api/admin/schools/[schoolId]/*` as requiring a valid operator cookie
  OR a school cookie whose `school_id` matches the path segment; everything
  else under `/api/admin` (e.g. `create`, `uploads/*`) requires operator.
  Caution: the proxy runs on the edge and `authorizeOperatorOrSchool` reads
  cookies via `next/headers` — mirror the cookie-read the proxy already does
  for the school/operator cookies rather than importing the handler helper.
- [ ] **Layer 2 (suspenders): add the helper call in every handler**, so a
  future proxy regression can't re-expose them. Pattern (already used
  correctly by `payments/plans/route.ts`):
  ```ts
  const auth = await authorizeOperatorOrSchool(schoolId);
  if (!auth.ok) return auth.response;
  ```
  Apply to all 44 ungated files. The full list is in the Appendix. Prioritize
  in this order (money/PII first):
  - **Billing:** `payments/invoices/route.ts`,
    `payments/invoices/bulk/route.ts`,
    `payments/invoices/[invoiceId]/{void,send,autopay}/route.ts`,
    `payments/config/route.ts`, `payments/discounts/route.ts`,
    `payments/enrollments/route.ts`, `payments/tuition-grids/route.ts`,
    `payments/bulk-facts-tuition/route.ts`, `payments/fa-to-discount/route.ts`,
    `payments/test-receipt-webhook/route.ts`,
    `tuition-plans/[enrollmentId]/action/route.ts`.
  - **Stripe Connect (see 1.3):** `payments/connect/route.ts`,
    `payments/connect-oauth/start/route.ts`,
    `payments/connect-oauth/callback/route.ts`,
    `payments/refresh-account/route.ts`.
  - **PII / data:** `sync-from-ghl/route.ts`, `roster-import/route.ts`,
    `staff/route.ts`, `ghl/contact-search/route.ts`,
    `parent-portal-branding/route.ts`, `parent-portal-forms/route.ts`,
    `portal-menus/route.ts`, `field-schema/route.ts`,
    `provision-defaults/route.ts`, `promote-parent2/route.ts`,
    `uploads/[uploadId]/{download,acknowledge,retry}/route.ts`.
  - `schools/create/route.ts` → **operator-only** (`requireOperator`); it has
    no `schoolId` and must never be dual-auth.
- [ ] Delete the false "authenticated via proxy" comments as you fix each one,
  so they stop giving a false sense of security.

**Verify:** for a representative sample, `curl -X POST` each route with no
cookie → 401; with a school cookie for a *different* school → 403
(`forbidden_cross_school`); with the matching school cookie → 200.

### 1.3 Stripe Connect OAuth — prevent payout-account repointing

**Finding (HIGH).** `connect-oauth/start/route.ts:21` has no auth, so anyone
knowing a `schoolId` can mint a validly-signed OAuth `state` for that school;
the callback decodes `schoolId` from `state` and `exchangeAndPersist`
overwrites `payment_accounts.stripe_account_id` (`ON CONFLICT (school_id) DO
UPDATE`). An attacker who completes Stripe consent with their *own* account
could repoint a school's connected account → future tuition settles to the
attacker. (The `state` HMAC + timing-safe verify + expiry is otherwise good.)

**Fix:**
- [ ] Auth `connect-oauth/start` (1.2 covers this) so only the authenticated
  school/operator can initiate.
- [ ] Bind the OAuth `state` to the initiating session (include a nonce tied to
  the session so a stranger can't mint `state` for an arbitrary school), and
  verify it in the callback.
- [ ] Consider requiring re-confirmation (operator step) before overwriting an
  existing `charges_enabled` connected account, so a relink can't silently
  redirect an already-live school's funds.

**Verify:** initiating the connect flow while unauthenticated → 401;
the callback rejects a `state` not bound to the current session.

### 1.4 `/api/school/family-credits` — add auth, derive `school_id` from session

**Finding (CRITICAL, verified by direct read).**
`app/api/school/family-credits/route.ts:41-46` reads `school_id` (and
`family_id`) from the POST body with **no session check**. The `apply` action
(`:79-158`) reduces `invoices.total_cents` and flips status to `'paid'`
(`:146-156`). An unauthenticated POST marks any invoice paid with no payment.
This route lives under `/api/school/*`, which the proxy matcher *excludes*
(`proxy.ts:380`), so nothing gates it. Its siblings (`go-live`,
`tuition-grids/save`) do call `verifySchoolSession` — this one was missed.

**Fix:**
- [ ] Add at the top of `POST`:
  ```ts
  const session = await verifySchoolSession(cookieValue);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  ```
- [ ] Use `session.school_id` for every query; **ignore any `school_id` in the
  body.** (Keep reading `family_id`/`invoice_id` from the body, but every
  query already filters `AND school_id = $` — point that at the session value.)
- [ ] Audit the other `/api/school/*` handlers for the same omission. The
  reviewers also flagged `ghl-sync` and `roster-settings` under `/api/school/*`
  as unauthenticated — confirm and fix the same way.

**Verify:** `curl -X POST /api/school/family-credits` with `action=apply` and a
guessed `school_id`/`invoice_id`, no cookie → 401 (today: applies the credit).

### 1.5 Delete the public CSV export path

**Finding (C2/C4).** `authorizeExportPublic` (`lib/exports/csv.ts:49-58`)
returns the school for any resolvable `locationId` with **no credential**.
`/api/export/*` is excluded from the proxy matcher (`proxy.ts:380`). Routes
using it (`student-roster`, `contacts`, `facts`, `facts-ledger`, `family-hub`,
`ghl-conflicts`) dump full-school student PII (names, DOBs, home addresses,
allergies, IEP/504), parent contact info, and FACTS financial ledgers to
anyone with a `locationId`. (`finance`, `rosters`, `enrollment-hub`,
`document-tracker` correctly use the stricter `authorizeExport`.)

**Fix:**
- [ ] Delete `authorizeExportPublic` and switch its callers to `authorizeExport`
  (session or valid `embed_token` required).
- [ ] Since exports are excluded from the proxy matcher, the per-handler check
  is the *only* gate — confirm every `/api/export/*` route calls
  `authorizeExport` and none fall through.

**Verify:** `curl /api/export/student-roster/<locationId>` with no cookie →
401 (today: returns the CSV).

### 1.6 Remove / hard-gate the demo bypasses

**Finding (H1).** `parent-portal/app/api/dev/login-as-parent/route.ts:44-55`:
if `PARENT_DEMO_BYPASS==='true'`, mints a session for any `parent_id`/`email`
with **no token and no `NODE_ENV` guard** — full account takeover of any
parent if the flag is ever set in prod. `DEV_AUTH_BYPASS` puts
`PARENT_SESSION_SECRET` in the URL query string (log/referer leak).

**Fix:**
- [ ] Gate the whole route on `NODE_ENV !== 'production'` (return 404 in prod),
  or delete it and keep only the safely-bounded `/api/demo-login` (which is
  limited by a `'%(demo)%'` display-name guard).
- [ ] Stop accepting the signing secret in a URL param anywhere.
- [ ] `preview-parent` (`portal`): add audit logging (it currently mints a
  parent session with none) and confirm it stays out of the proxy allow-list
  so it isn't reachable unauthenticated.

**Verify:** in a prod-like build, `GET /api/dev/login-as-parent?email=…` → 404.

---

## Phase 2 — HIGH

### 2.1 Rate-limit authentication endpoints
- [ ] Operator login `app/api/login/route.ts` — add per-IP throttle + lockout
  (single shared `ADMIN_PASSWORD`, 7-day session → brute-force target).
- [ ] Parent `password-signin` and magic-link/`request-link` issuance
  (`portal`) — add per-IP/per-email limits (the kiosk PIN path already has a
  good pattern: `portal/app/api/kiosk/[schoolId]/verify/route.ts:51-64`).
- [ ] Cap `parent_magic_link_tokens` issuance (H6: email-bombing + unbounded
  table growth).

### 2.2 Cron fail-closed
- [ ] `portal/app/api/cron/process-autopay/route.ts:37-40` currently checks the
  secret only `if (secret)` — make it **fail closed**: 401 when `CRON_SECRET`
  is unset or mismatched. (Dashboards crons already do this — mirror them.)

### 2.3 Token hygiene
- [ ] Enforce `exp` (and check `aud`/`iss`) on the GHL menu-link JWT
  (`lib/auth/school.ts:55-58`) — see 1.1.
- [ ] Give `cosign_token` an `expires_at` (`migrations/065_form_cosign.sql`;
  today it never expires while `awaiting`, and the no-login `/cosign/{token}`
  page exposes full submission PII).
- [ ] Shorten the co-parent invite (`portal/lib/auth/co-parent-invite.ts`) from
  7 days, or scope what the resulting session can do; today it grants a full
  30-day parent session to whoever opens that email.
- [ ] Stop overloading keys: `ENCRYPTION_KEY` doubles as the preview-parent
  HMAC key; `EMBED_TOKEN_SECRET` doubles as the view-as-parent fallback. Give
  each purpose its own secret.

### 2.4 CSRF + framing
- [ ] Add CSRF tokens to state-changing form-POST mutations (the school cookie
  is `SameSite=None` for iframe use, so SameSite is not a sufficient defense).
- [ ] Replace the dashboards `frame-ancestors https:` wildcard
  (`next.config.ts`) with a GHL-origin allowlist (the portal already does this
  correctly — mirror it). Note this is only safe *after* 1.1, since framing +
  auto-mint together = live data in any attacker's iframe.

---

## Phase 3 — STRUCTURAL (enterprise-review readiness)

These won't block a first sale to a friendly design partner, but any serious
buyer's security questionnaire will ask about them, and they're the difference
between "defensible" and "passes an enterprise review."

### 3.1 Staff role separation for financial aid
- [ ] The school session (`lib/auth/school.ts:24-30`) has no role field, so any
  staff member can read every family's FA tax docs and income and set awards.
  The FA wizard promises parents this data stays "within the committee"
  (`wizard-schema.ts:98`) — the code can't currently honor that. Add a role /
  permission to the session and gate FA read + award routes
  (`fa-applications/file`, `set-award`, `analyze`, the `FinancialAidQueue`
  widget) to an FA-committee role.

### 3.2 Database-level tenant isolation (RLS)
- [ ] There is no Postgres row-level security; isolation is entirely
  application-level `WHERE school_id = $`. All services share one
  `DATABASE_URL`. Add RLS policies keyed on a per-request tenant GUC as a
  defense-in-depth backstop so one forgotten filter can't leak cross-tenant.
  Roll out in *permissive/log* mode first against a staging copy — a bad
  policy will silently break queries across four apps.

### 3.3 Encrypt sensitive data at rest
- [ ] FA income/asset/narrative fields (`fa_applications.responses` + flat
  columns) and tax-document blobs (`fa_application_files.contents`) are stored
  plaintext. The AES-256-GCM helper (`lib/crypto.ts`) exists and is used for
  GHL tokens — extend it to FA financial + document data. Consider health data
  (allergies/medications/immunizations) as a fast follow.

### 3.4 Admin action audit log
- [ ] No actor-attributed audit trail for invoice void/refund, config changes,
  award decisions, or Connect relink. Add an append-only `admin_audit_log`
  (actor identity, action, target, before/after, timestamp). This depends on
  1.1 delivering real per-user identity (today mutations are attributed to
  `embed@iframe`).

### 3.5 Data-integrity constraints
- [ ] Add `CHECK (… >= 0)` to FA money columns
  (`fa_applications.requested_aid/recommended_award/current_tuition_owed`,
  `fa_application_students.*`) — today only app code guards negatives; the
  discounts/credits tables already have these constraints, so match them.
- [ ] Content-sniff uploaded file MIME instead of trusting client `file.type`
  (`submit/route.ts`, `upload-doc/route.ts`).

---

## Phase 4 — COMPLIANCE / paperwork (parallel, mostly non-code)

- [ ] **Subprocessor disclosure.** FA submissions send full income/asset/
  narrative PII to the Anthropic Claude API for analysis
  (`fa-applications/[id]/analyze`). List Anthropic (and Stripe, Supabase,
  Resend, GHL, Vercel) in the DPA/subprocessor list.
- [ ] **PCI posture:** document the SAQ-A story (tokenized cards, no PAN on
  servers, funds settle to the school's Stripe). This is your strongest
  talking point with the partner — write it down.
- [ ] **DPA + privacy policy** covering children's data (FERPA/COPPA
  considerations) and family financial data.
- [ ] **Third-party penetration test** before the brand goes live — after
  Phase 1, budget for an external pen test; a clean report is what a nervous
  partner actually wants to see.
- [ ] **Incident-response + breach-notification** runbook.

---

## Definition of done for "safe to sell"

- **Minimum bar (defensible):** Phase 0 confirmed + all of Phase 1 shipped and
  verified + Phase 2.1/2.2. At that point the verified critical data-breach and
  integrity holes are closed.
- **Enterprise-ready:** + Phase 3 (roles, RLS, encryption, audit) + Phase 4
  (subprocessor disclosure, DPA, clean external pen test).

---

## Appendix — the 44 ungated `/api/admin` route files

Grep basis: `app/api/admin/**/route.ts` files containing no call to
`authorizeOperatorOrSchool` / `requireOperator` / `verifySchoolSession` /
`checkServiceAuth`. Each must be individually confirmed and fixed (a few may do
a bespoke check the grep missed — verify, don't assume). Money/PII-bearing
routes are prioritized in 1.2 above.

```
schools/create                              (anonymous school creation — operator-only)
schools/[schoolId]/payments/invoices
schools/[schoolId]/payments/invoices/bulk
schools/[schoolId]/payments/invoices/[invoiceId]/void
schools/[schoolId]/payments/invoices/[invoiceId]/send
schools/[schoolId]/payments/invoices/[invoiceId]/autopay
schools/[schoolId]/payments/config
schools/[schoolId]/payments/discounts
schools/[schoolId]/payments/enrollments
schools/[schoolId]/payments/tuition-grids
schools/[schoolId]/payments/bulk-facts-tuition
schools/[schoolId]/payments/fa-to-discount
schools/[schoolId]/payments/test-receipt-webhook
schools/[schoolId]/payments/connect
schools/[schoolId]/payments/connect-oauth/start
schools/[schoolId]/payments/connect-oauth/callback
schools/[schoolId]/payments/refresh-account
schools/[schoolId]/tuition-plans/[enrollmentId]/action
schools/[schoolId]/sync-from-ghl
schools/[schoolId]/roster-import
schools/[schoolId]/promote-parent2
schools/[schoolId]/provision-defaults
schools/[schoolId]/field-schema
schools/[schoolId]/staff
schools/[schoolId]/ghl/contact-search
schools/[schoolId]/parent-portal-branding
schools/[schoolId]/parent-portal-forms
schools/[schoolId]/portal-menus
schools/[schoolId]/menu-editors
schools/[schoolId]/notifications
schools/[schoolId]/notifications/count
schools/[schoolId]/enrollments/start
schools/[schoolId]/forms/[formId]
schools/[schoolId]/forms/[formId]/duplicate
schools/[schoolId]/forms/[formId]/test-submit
schools/[schoolId]/forms/[formId]/test-submit/clear
schools/[schoolId]/forms/[formId]/test-submit/send-email
schools/[schoolId]/products
schools/[schoolId]/products/[productId]
schools/[schoolId]/purchases/[purchaseId]/refund
uploads/[uploadId]/download
uploads/[uploadId]/acknowledge
uploads/[uploadId]/retry
```

Separately, under `/api/school/*` (proxy-excluded, must self-auth) confirm and
fix: `family-credits` (verified unauth, 1.4), plus reviewer-flagged `ghl-sync`
and `roster-settings`.
</content>
</invoke>
