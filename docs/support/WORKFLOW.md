# Support Workflow — End to End

**Tools in play:** Intake form → **Freshdesk** → **N8N** (triage AI on Claude
API) → **Claude Code** (Kelly = team seat, Clint = Max) → Freshdesk reply.
**Notion** = a behind-the-scenes **per-school log of tickets + communication**
(the historical record) — NOT the brain. The triage AI's KB / playbook sources
live elsewhere (Freshdesk KB / Airtable / repo docs — *to be decided*).

**Who's who:** Kelly = front line (runs tickets). Clint = escalations + platform
fixes + writes playbooks. Partner = owns the pipeline (Freshdesk/N8N/triage).

---

## The journey of one ticket

**1–3. Intake → triage (automatic, no human yet)**
- Customer fills the **intake form** (constrained dropdowns — no gibberish).
- Form → `growthsuite@montessoricompass.com` → **Freshdesk**, auto-tagged `GS TICKET`.
- Freshdesk → **N8N**. The triage AI (Claude API, isolated) does four things:
  1. **Classifies** the ticket: *info/KB · safe-change · escalate · sales*.
  2. **Selects the matching Playbook** from the KB/playbook source (it does
     **not** write exact commands — see the safety rule at the bottom).
  3. Writes the **A–E private note** in Freshdesk.
  4. **Logs the ticket to Notion** (under that school's record) and **assigns the
     Freshdesk ticket to Kelly**.
- → **Kelly's queue = Freshdesk tickets assigned to her.**

**4. Kelly picks it up — one of three outcomes:**

### Outcome 1 — Info / KB answer (no system change)
The note's answer is a knowledge-base response ("here's where that setting
lives"). Kelly reads it, confirms it's right, **sends reply E**, closes.
Updates Notion (*resolved_by: kelly, no change*). **No Claude Code needed.**

### Outcome 2 — A change on the safe list
1. Kelly opens **Claude Code** (her team seat), pastes the private note.
2. Her Claude **confirms the school by name**, **reproduces the issue** from live
   state, and writes the **exact fix + before/after** (Section C).
3. **Phase 1 (now):** she does **not** apply it. She sends the plan to **Clint to
   review** → Clint approves + applies (or okays her to) → verify (D) → **reply
   (E)** → close.
4. **Phase 2 (once Clint trusts that ticket type):** Kelly applies it herself
   (dry-run → apply), verifies, replies, closes — **no Clint**.
5. Notion updated with **actions before→after**.

### Outcome 3 — Escalate to Clint
Triggers: **denylist** (billing / contact data / deletion / DGM or MCH / code) ·
**can't reproduce** · **can't verify** the issue or the fix · **novel** (no
playbook). Kelly **reassigns the Freshdesk ticket to Clint** + private note
"escalating: <reason>", flips the **Notion** row to *Escalated*. She does **not**
reply to the customer.

---

## The escalation lane (what Clint does)
1. It lands in Clint's **Freshdesk queue** (assigned to him) / Notion *Escalated*.
2. Clint opens **his Claude Code (Max)** and resolves it — either a config change
   or a **platform code fix** (short branch → `master` → helps every school).
3. If it was **novel**: Clint writes it up as a **new Playbook in Notion** → next
   time the triage AI matches it and it becomes a Kelly-handleable ticket type.
4. Clint hands back (reassign in Freshdesk + "fixed, reply OK") — Kelly
   **verifies + sends the reply + closes** — or Clint replies directly.
5. Notion: *resolved_by: clint*, *is_novel* flagged, playbook linked.

---

## Swimlane (quick reference)

| Stage | Owner | Tool | Output |
|---|---|---|---|
| Submit | Customer | Intake form | Structured ticket |
| Route + triage | Auto | Freshdesk → N8N | Tagged, classified |
| Draft + classify | Triage AI | Claude API + KB source | A–E note, playbook match |
| Log ticket | Auto | Notion | Row under the school's record |
| Assign | Auto | Freshdesk | Ticket in Kelly's queue |
| Diagnose / fix | Kelly | Claude Code (seat) | A–E resolution (Phase 1: proposed) |
| Review (Phase 1) | Clint | — | Approve / apply |
| Escalate | Kelly → Clint | Freshdesk reassign + Notion | Clint's queue |
| Resolve escalation | Clint | Claude Code (Max) | Fix + new playbook |
| Reply + close | Kelly | Freshdesk | Customer answered |
| Record | Auto/Kelly | Notion | Full ticket history |

---

## Phase 1 vs steady state
- **Phase 1 (now):** Clint **reviews every change-ticket** before it applies.
  Kelly closes only pure **info/KB** answers on her own. Training period.
- **Phase 2:** Kelly closes the **safe list** herself. Only **denylist /
  can't-verify / novel** escalate. Clint's load drops to escalations + platform
  fixes + writing playbooks.
- **The graduation gate** = the Notion metrics (auto-resolve %, escalation %,
  reopen rate). A ticket type moves to Phase 2 on data, not vibes.

## The one rule that keeps it safe
The **triage AI is blind** (Claude API, no live access) — so it **classifies and
points to a playbook**, it does **not** author exact commands. **Kelly's Claude
Code** (which can see live state) writes the actual fix and **refuses if the
issue doesn't reproduce.** That stops a blind hallucination from ever becoming a
live change.

## Notion = the per-school log (behind the scenes)
Notion is **only** the customer-service record, organized **per school** — a
searchable history of every ticket + the communication on it. It is not the
brain (no playbooks/KB there) and it's internal-only (customers never see it).
- **Structure:** a **Schools** database + a **Tickets** database related to it,
  so each school shows its full ticket/communication history in one place.
- Triage AI **logs** each ticket; Kelly **updates** it as she works; the thread
  of communication is captured for reference.
- You can still **report** off it later (volume, % escalated, reopen rate), but
  its first job is just "what has this school contacted us about, and how did we
  handle it."

> Open item: **where do the KB + playbooks live** (the triage AI's sources)?
> Options: Freshdesk KB · Airtable · repo docs. Pick one — it's separate from
> the Notion log.
