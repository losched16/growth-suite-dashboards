# Kelly Support Setup — Step by Step

Goal: Kelly can open Claude Code on her own computer, with her own accounts, and
work Growth Suite support tickets. Nobody shares a password. ~45 minutes total.

Legend:  **[CLINT]** = you do it   ·   **[KELLY]** = she does it

---

## PART 1 — [CLINT] Create the Claude Team (5 min)
1. Go to **claude.ai** and log in.
2. Open **Settings** (your name / avatar, bottom-left) → look for **"Team"** or
   **"Upgrade"** (or go straight to **claude.ai/team**).
3. Choose the number of **seats** (at least 2: you + Kelly) and enter the
   company card. This is the central bill — one plan, everyone under it.
4. Go to **Members → Invite**, type **Kelly's work email**, send.
   > Note: the Team plan includes Claude Code usage. If Kelly ever hits a usage
   > limit doing heavy work, we bump her to Max or give her an API key — not a
   > concern for normal tickets.

## PART 2 — [KELLY] Accept the invite (2 min)
5. Open the invite email → **Accept** → create or log in to her Claude account.
   She's now on the team. (She could use claude.ai in the browser now, but the
   real tool is Claude Code — next.)

## PART 3 — [KELLY] Install Claude Code on her computer (10 min)
6. Install **Node.js**: go to **nodejs.org**, download the **LTS** version, run
   the installer, click Next through it. (This is the engine Claude Code runs on.)
7. Open a terminal:
   - **Windows:** Start menu → type **PowerShell** → open it.
   - **Mac:** Cmd+Space → type **Terminal** → open it.
8. In the terminal, paste and press Enter:
   ```
   npm install -g @anthropic-ai/claude-code
   ```
9. Now type and press Enter:
   ```
   claude
   ```
   It opens a browser → **log in with her team Claude account**. Done — Claude
   Code is installed and billed to the team plan.

## PART 4 — [CLINT] Give Kelly the code (GitHub) (5 min)
10. [KELLY] Make a free account at **github.com** (if she doesn't have one) and
    send you her **username**.
11. [CLINT] For **each** repo — `growth-suite-dashboards` **and**
    `growth-suite-parent-portal`:
    - Open the repo on github.com → **Settings** → **Collaborators** →
      **Add people** → type her username → pick **Read** access → Add.
12. [KELLY] Accept both GitHub invite emails.

## PART 5 — [KELLY] Download the code + guardrails (10 min)
13. Install **Git**: go to **git-scm.com**, download, run the installer (click
    through the defaults).
14. Make a folder for the work, e.g. `growth-suite-support`. In the terminal:
    ```
    cd path/to/growth-suite-support
    git clone https://github.com/losched16/growth-suite-dashboards.git
    git clone https://github.com/losched16/growth-suite-parent-portal.git
    ```
15. Save the **guardrails file** Clint sends (`SUPPORT-GUARDRAILS.md`) into this
    folder, renamed to **`CLAUDE.md`**, sitting **next to** the two repo folders.
    (This is the rulebook Claude Code reads automatically every session.)

## PART 6 — [CLINT] Credentials (the careful step, ~15 min)
Kelly's Claude needs **read** access to the database + GHL to *reproduce*
issues. **Never** email or paste secrets in chat.
16. Create a **read-only database login** (I can generate the exact SQL for a
    read-only role — just ask) and a **read GHL token**.
17. Share them through a **secrets vault** (1Password / Doppler), not email.
18. [KELLY] Save them as **`.env.local`** inside each repo folder (Clint tells
    her which lines go where).
    > Phase 1 she's **propose-only** — she reads and plans, never writes. So
    > read-only creds are enough and safe. We add write access later, carefully.

## PART 7 — [KELLY] Working a ticket (the daily routine)
19. Open the terminal → `cd` into the `growth-suite-support` folder → type
    `claude`.
20. Paste the ticket's **Freshdesk private note**.
21. Claude reads `CLAUDE.md`, **confirms the school by name**, reproduces the
    issue, and writes the **A–E resolution** (summary → how to verify → the fix →
    how to confirm → customer reply).
22. **Phase 1:** she does **not** apply the fix — she sends the plan to Clint to
    review. Once Clint trusts a ticket type, he turns on "apply" for it.

---

## Quick "who owns what"
- **[CLINT]** Claude Team billing/seats · GitHub access · credentials ·
  reviewing Phase-1 tickets · platform code fixes.
- **[KELLY]** Install on her computer · run tickets · escalate when unsure.
- **Shared brain:** rules live in the repo (`CLAUDE.md`); KB + playbooks + ticket
  log live in **Notion**.

## The one thing that won't travel by itself
The knowledge "my Claude" built up lives in **Clint's local memory**, not in the
repos — so Kelly's Claude starts without it. Fix: keep **rules in the repo** and
**support knowledge in Notion** so both Claudes share the same brain.
