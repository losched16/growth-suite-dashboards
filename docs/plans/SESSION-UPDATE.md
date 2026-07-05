# Session update — for phone review

*Everything below is DEPLOYED to production and verified unless marked
"staged" or "needs you". DGM was never touched — every change is either
additive, new-school-only, or verified transparent to DGM's live usage.*

---

## 🔴 The big one: a live security backdoor was found + closed

`PARENT_DEMO_BYPASS=true` was set in the **portal production** environment — a
full account-takeover backdoor (anyone could log in as any parent by guessing
an email). **Closed:** removed the env var, redeployed, and hard-coded the dev
login route to return 404 in production so an env flag can never reopen it.
Also found the autopay charge cron was publicly triggerable (missing
`CRON_SECRET`) — **fixed + set**, now returns 401 without the secret.

---

## ✅ Deployed this session

**Security (Phase 1 — closes the pre-sale blockers):**
- Dev login backdoor → hard 404 in prod
- Autopay cron → fail-closed (401 without secret)
- `family-credits` → authenticated (was: mark any invoice paid, no login)
- **38 unauthenticated `/api/admin` routes → now gated** (invoice void/send,
  payments config, connect-oauth, roster-import, staff, sync, uploads, etc.)
- **6 full-PII CSV exports → now require a session/token**
- Verified live: gated routes return **401 without auth** but **200 with DGM's
  real embedded session** — so DGM's admin UI is untouched.

**Billing:**
- Fixed a latent **payment-plan schedule crash** — non-standard installment
  counts (4, 12, custom) used to crash enrollment generation. Fixed so all
  counts work; every existing plan shape produces identical dates (zero impact
  on MCH/DGM billing). Verified end-to-end.
- Grid add-ons, school-editable late fees, custom portal domain, Financial-Aid
  settings tab, and FA-award→discount auto-conversion — all reviewed, tested,
  and live (from the earlier branch).

**School onboarding portal:**
- Confirmed the whole flow works end-to-end (status engine correctly derives
  progress from real data).
- Fixed "Forms published" counting unpublished drafts.
- **NEW: one-click "Provision & connect"** on the onboarding board — from a
  location ID + PIT it pushes the 150-field kit, creates the school (dashboards,
  payment config, field schema), links it, and runs the audit. One action turns
  a lead into a connected, audited school.
- **NEW: "Provision missing fields"** button on the field-audit page — fills any
  gaps on an existing school's location using its stored credentials.
  Idempotent (safe to re-click).

**Also:** migrations 072–074 run; onboarding env vars set; marketing-client
onboarding SOP + client-expectations docs written.

---

## 🟡 Needs you (two things)

1. **Resend API key** → paste it so I can set it in the *dashboards* project.
   That lights up the onboarding "Email the link" button + reminder emails
   (sender domain is already verified — it's a one-paste fix).
2. **Auto-mint / embed-token migration** (the last security item) — this one
   touches DGM's GHL menu links, so we should do it together. It removes the
   credential-free session mint by first putting embed tokens on each school's
   menu links.

---

## How to look deeper (repo files)
- `docs/plans/PHASE1-STAGED-REVIEW.md` — security: deployed vs staged + test steps
- `docs/plans/SECURITY-REMEDIATION-PLAN.md` — full security plan (Phase 0 done)
- `docs/plans/SCHOOL-ONBOARDING-PORTAL-PLAN.md` — onboarding portal architecture
- `docs/SELF-SERVE-STATE.md` — overall self-serve state

*Nothing here needs action right now — it's a status snapshot. The two "needs
you" items are the only blockers, and both can wait until you're back at a
computer.*
