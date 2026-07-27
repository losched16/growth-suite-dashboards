# Stand It Up Today — Clint's Critical Path

Goal: Kelly's Claude Code can reach any school's data to work a ticket, safely,
under Phase-1 propose-only rules. ~1 hour of your time. Your partner runs the
intake→Freshdesk→N8N→Notion pipeline in parallel; the two halves meet where the
triage note lands and Kelly picks it up.

**How "access to a school sub-account via Claude" actually works:** Kelly's
Claude Code reads the repo code + **two secrets** — `DATABASE_URL` (the app DB)
and `ENCRYPTION_KEY` (which decrypts each school's stored GHL token). With those,
her Claude can query any school's data and reach its GHL, scoped by
`school_id` / `location_id`. That's the whole mechanism — grant those two, you've
granted access.

---

## STEP 1 — GitHub access (5 min) — [CLINT]
1. Ask Kelly for her **GitHub username** (free account at github.com if she has none).
2. github.com → `losched16/growth-suite-dashboards` → **Settings → Collaborators**
   → **Add people** → her username → **Read** → Add.
3. Repeat for `losched16/growth-suite-parent-portal`.
4. Kelly accepts both invite emails.

## STEP 2 — Create a read-only DB login for Kelly (20 min) — [CLINT]
This is the safety win: even if the guardrails are ignored, she **cannot write
to the database.** Run this in the Supabase SQL editor:

```sql
-- Read-only support role
CREATE ROLE kelly_support WITH LOGIN PASSWORD '<pick-a-strong-password>';
GRANT CONNECT ON DATABASE postgres TO kelly_support;
GRANT USAGE ON SCHEMA public TO kelly_support;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO kelly_support;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO kelly_support;
```

Her connection string = your current `DATABASE_URL` with the **user + password
swapped** to `kelly_support` / the password above (same host, same
`?sslmode=require`).

> Fast alternative if you're truly out of time: hand her the existing
> `DATABASE_URL` under propose-only guardrails and swap to read-only tomorrow.
> Riskier — the read-only role is only 20 minutes, do it if you can.

## STEP 3 — Package the 2 secrets + guardrails for Kelly (10 min) — [CLINT]
Kelly's `.env.local` (goes in **each** repo folder) needs only:

```
DATABASE_URL=<the kelly_support read-only connection string>
ENCRYPTION_KEY=<same value as yours — needed to decrypt GHL tokens for repro>
```

That's it for Phase 1 reproduction. **Do NOT** give her Stripe / Resend / agency
keys — not needed to work tickets, and they're the crown jewels.

Send Kelly, through a **secrets vault (1Password/Doppler)** — not email/Slack:
1. the two env values above,
2. `support/SUPPORT-GUARDRAILS.md` (her rulebook),
3. `support/KELLY-SETUP.md` (her install steps).

## STEP 4 — Kelly installs + connects (20 min) — [KELLY, you coach]
Following `KELLY-SETUP.md`:
1. Install **Node.js** (LTS) + **Git**.
2. `npm install -g @anthropic-ai/claude-code` → `claude` → log in with her **team seat**.
3. Make a workspace folder; `git clone` both repos into it.
4. Drop the `.env.local` into **each** repo folder.
5. Save the guardrails as **`CLAUDE.md`** at the **workspace root** (next to the
   two repo folders), so Claude Code loads it every session.

## STEP 5 — Prove it on ONE ticket, on GS Test (15 min) — [CLINT + KELLY]
Do the first run against the **safe test account** — GS Test School, location
`YmLinBRSvCUgB6unrX0g` — never a real school for the first test.
1. Give Kelly a known issue, e.g. *"Location YmLinBRSvCUgB6unrX0g — is field X
   showing on the roster?"*
2. She runs `claude` in the workspace and pastes it.
3. Confirm her Claude: **echoes the school name**, **reproduces from live data**,
   and produces the **A–E** write-up.
4. She sends you the plan; you confirm it's right. **That's the loop working.**

## STEP 6 — Handoff to the partner's pipeline
Partner wires: intake form → Freshdesk (`GS TICKET`) → N8N → triage AI →
private A–E note + Notion log + **assign ticket to Kelly**. Until that's live,
**you can hand Kelly tickets manually** — she's already able to work them the
moment Steps 1–5 are done.

---

## The one risk to accept with eyes open (Phase 1)
The read-only DB role blocks DB writes. But `ENCRYPTION_KEY` lets her Claude
decrypt any school's GHL token, so a **GHL write** is technically possible — the
only thing stopping it in Phase 1 is the **propose-only guardrail** (and Kelly's
judgment). That's an acceptable, conscious risk for a trusted employee in a
propose-only phase; we scope GHL tokens properly before Phase 2 turns on writes.

## Today's definition of done
- [ ] Kelly is a Read collaborator on both repos
- [ ] `kelly_support` read-only DB role created
- [ ] Kelly has the 2 env values + guardrails (via vault)
- [ ] Claude Code installed, both repos cloned, `CLAUDE.md` at workspace root
- [ ] One GS-Test ticket run end-to-end, A–E verified
