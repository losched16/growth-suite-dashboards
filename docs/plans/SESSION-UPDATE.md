# Session update — for phone review

*Everything below is DEPLOYED to production and verified unless marked
"needs you". DGM was never touched — every change is additive, new-school-only,
or verified transparent to DGM's live usage.*

---

## 🆕 Newest work (top = most recent)

### AI form import — schools bring their own forms
Schools can now import an existing form instead of rebuilding it by hand.
On the **New form** page: **upload a PDF (or several)** or **paste a public
Google Form link** → Claude drafts the fields → school refines in the builder
and publishes. Native rebuild only, so submissions flow into the contact record.
- **Verbatim guaranteed:** form language is reproduced character-for-character —
  no rewording, no summarizing, no "corrections." Proven: it even preserves a
  source form's own typo ("Adress") instead of fixing it. Legal/consent/medical
  wording is safe.
- **Batch:** up to 8 PDFs at once, each becomes its own draft.
- Verified end-to-end on a real MCH consent PDF (correct sections, field types,
  per-item consent signatures). Google Form path shares the same proven parser
  — **please test it once with one of your real public Google Forms.**

### Onboarding portal = system setup only
Per your call: the portal is now exclusively for setting up a school's system
(account → data → config → launch). The marketing/growth how-to's were removed;
those live in **Freshdesk** as a separate "Help & Guides" GHL menu item. The
portal shows one line pointing there instead of per-task outbound links.
SOP drafts for Freshdesk are in `docs/onboarding-sop-drafts.md`.

### Self-resolving onboarding menu link
One static GHL menu link per school ("Set Up Your School") now auto-resolves
that school's onboarding — no per-onboarding token juggling. Same embed-token
pattern as your dashboard links. Pattern:
`…/school/{LOCATION_ID}/onboarding?chrome=none&embed_token={TOKEN}`

### One-click provisioning
On the onboarding board, **"Provision & connect"** takes a location ID + PIT and
does everything (150-field kit push, create school, starter dashboards, field
schema, audit) in one action. Plus a **"Provision missing fields"** button on
the field-audit page for existing schools.

### Onboarding email layer — LIVE
Resend is wired into the dashboards project; "Email the link" + reminder cron
now actually send (verified). Sender is `onboarding@montessori.org` (interim);
verify `mygrowthsuite.com` in Resend if you want Growth-Suite-branded sends.

### Your operator password was reset
You didn't have it, so I set a new one: **`Compass-Admin-3893-Ridge`**
(change it anytime — tell me, or Vercel → dashboards → Env Vars → ADMIN_PASSWORD).
Log in at `…/admin/onboarding`.

---

## ✅ Already live (earlier this stretch)

- **Security:** closed a LIVE account-takeover backdoor (PARENT_DEMO_BYPASS was
  on in prod); gated 38 admin routes + 6 PII CSV exports + autopay cron +
  family-credits — verified DGM's real session still passes (200), attackers 401.
- **Billing:** fixed a payment-plan schedule crash on non-standard installment
  counts (existing plans byte-identical, MCH untouched); grid add-ons, late
  fees, custom portal domain, FA settings tab, FA→discount all live.
- **Onboarding help guides** (Freshdesk link system) + marketing modules were
  built then intentionally slimmed out of the portal per the decision above.

---

## 🟡 Needs you (nothing urgent)

1. **Test the Google Form import** with one real public Google Form (I can't
   make a public one from here). Share it "Anyone with the link," paste it in.
2. **Auto-mint / embed-token migration** — the last security item; we do it
   together (it touches DGM's GHL menu links).
3. Optional: change the operator password; verify mygrowthsuite.com in Resend.

---

## How to keep working on mobile

Plan and review here. To start a mobile session, open the
`growth-suite-dashboards` repo and reference this file. Good next-step ideas we
discussed:
- **Forms:** auto-suggest GHL field mappings on import (so the school doesn't
  map every field by hand).
- **Provisioning:** tuition/billing setup walkthrough, or the parent-portal
  config self-serve audit.

Deployment stays on the desktop (it holds the DB/GHL/Stripe creds). Write plans
as notes and I'll execute them when you're back at a computer.

*Key docs: `docs/plans/PHASE1-STAGED-REVIEW.md` (security), `docs/SELF-SERVE-STATE.md`
(overall), `docs/onboarding-sop-drafts.md` (Freshdesk SOP source),
`docs/ghl-field-kit.md` (the field contract).*
