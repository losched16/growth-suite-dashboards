# docs/plans — session handoff index

Entry point for the work produced in the cloud planning session (no
DB/GHL/Stripe creds there; **nothing was deployed**). Everything is committed
and pushed for the desktop session to review, test, and deploy.

## Two branches to deploy (same name, two repos, shared DB — deploy both)

- `growth-suite-dashboards` → `claude/recent-updates-visibility-rh79by`
- `growth-suite-parent-portal` → `claude/recent-updates-visibility-rh79by`

## The docs here

1. **`SELF-SERVE-GAP-CODE-HANDOFF.md`** — the code shipped this session, with a
   per-feature test checklist and the remaining-items list. Six deploy-ready
   features (grid add-ons, school late fees, custom portal domain, FA settings
   tab, FA→discount auto-conversion, portal academic-year fix) + one
   **deliberately-not-coded** item (payment-plan schedule bug — see its
   "Investigation needed" section; it's live-billing date math that needs a
   running app to fix safely).
2. **`SECURITY-REMEDIATION-PLAN.md`** — the pre-sale security assessment +
   fix plan (auth/tenant-isolation holes on the staff side; the payment
   *mechanics* are sound). Starts with an **"Interim posture for MCH"** section:
   MCH can keep taking payments, with a short list of MCH-scoped quick
   mitigations to do first (top one: set `require_staff_login = true` for MCH —
   one DB row, no deploy).

## Suggested order at the desktop

1. **Security Phase 0 (urgent, minutes):** confirm `PARENT_DEMO_BYPASS` is NOT
   set in prod; do the MCH-scoped quick mitigations. (SECURITY-REMEDIATION-PLAN.)
2. **Deploy the six self-serve features** — each is typecheck+eslint-clean;
   walk its test checklist (esp. the FA→discount and grid-addon → enrollment
   end-to-end checks) before/after deploy. Deploy both repos.
3. **Fix the payment-plan schedule bug** with a dry-run test enrollment (never
   against MCH), then the custom-installment UI is trivial.
4. **Security Phase 1** — the bigger auth hardening, before onboarding any new
   school under the partner brand.

## Also in the repo (context, not from this session)

`docs/SELF-SERVE-STATE.md` (the mobile-planning handoff), `docs/SCHOOL_ONBOARDING.md`,
`docs/BILLING-PAYMENTS-HANDOFF.md` — the standing product/onboarding docs the
above builds on.
</content>
