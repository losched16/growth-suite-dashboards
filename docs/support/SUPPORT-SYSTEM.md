# Growth Suite Support System — Partner Meeting Brief

Purpose: let a support person (Kelly) resolve most tickets by conversing with
Claude Code, safely, without every issue routing through Clint. This is the
architecture + rollout + the one big decision we need to make together.

---

## The flow (as designed) — this part is solid

1. **Intake form** — dropdowns + multiselect force correct nomenclature; no
   free-flowing gibberish. Identify the issue right on first intake.
2. Form → `growthsuite@montessoricompass.com` → **Freshdesk**, auto-tagged `GS TICKET`.
3. Freshdesk → **N8N**. Triage AI reads the GS ticket, decides: sales / support /
   KB-answer / a real "do-it-for-them" change.
4. Triage AI → **Claude API** (isolated; no personal context, only our sources).
5. Claude reviews KB / Airtable → determines the resolution.
6. Triage AI → **private draft note** in Freshdesk.
7. **Kelly** works the private note (A–E structure below).
8. Full history → **Airtable** for reference + self-learning.

Keep all of it. Two additions make it safe and scalable: a **branching
decision** (§1) and a **phased-autonomy rollout with guardrails** (§2–3).

---

## 1. THE BIG DECISION: kill per-client branches

**Problem:** today there's a forked branch per client. On a multi-tenant
platform (shared code, shared database) that gets messy fast — and it's exactly
the worry raised: when overall changes hit the repos, per-client forks fall
behind and merging them back is where the pain is. We watched `master` move
**~62 commits in two weeks**; any stale fork is a merge headache, and a fork
can't even deploy (prod serves everyone from `master`).

**The model to adopt (already your stated direction — "stop per-school forks"):**

Support work is one of two kinds, and neither needs a per-client branch:

| Kind | What it is | How it's isolated | Where it happens |
|---|---|---|---|
| **Tenant data/config** | This school's dashboard, form, settings, portal menu, GHL sub-account | `WHERE school_id = …` + their own GHL location | On `master`, scoped by ID — **no branch** |
| **Platform code fix** | A real bug/feature that should help every school | Short-lived branch → review → merge to `master` | Benefits all schools at once |

So: **isolation is the `school_id`, not a git branch.** A client always runs the
latest code + their own data — no fork, no merge. If a "client issue" truly
needs bespoke code, that's a signal to make it **configurable/self-serve**
(the whole thrust of the data layer we've been building), not to fork.

**Net for Kelly:** she never touches a code branch. She works on `master`,
scoped to one school. Anything needing code → escalates to Clint.

---

## 2. Phased autonomy (Clint's call: escalate first, then loosen)

- **Phase 1 — Propose-only (now).** Kelly's Claude Code *diagnoses and writes the
  fix but does not apply it.* Every resolution goes to Clint for review. This is
  the training-wheels phase — we learn what she gets, what's safe, what's not.
- **Phase 2 — Kelly-auto on the safe list.** Once a ticket type has been reviewed
  a few times and trusted, Clint signs it off and Kelly can apply it herself
  (still logged, still reversible).
- **Phase 3 — Expand the allowlist** as playbooks accumulate. Novel issues always
  start Phase-1-style (Clint reviews) and graduate.

The propose-only guardrail lives in `SUPPORT-GUARDRAILS.md` (drop-in `CLAUDE.md`
for Kelly's workspace). Flipping phases = editing one line in that file.

---

## 3. Tier lists (the allowlist / denylist)

**Safe (Kelly-auto candidates — propose-only in Phase 1):**
read-only diagnosis · re-send a form/notification/welcome email · toggle a
portal menu · surface/hide a dashboard column/filter · re-run a school's sync ·
adjust a form's visibility targeting · add/re-provision a family's portal login.

**Always escalate to Clint (never self-serve, any phase):**
billing/invoices/payments/tuition · GHL contact data (name/email/phone — edited
*in GHL*, not our DB) · any deletion · migrations/schema · auth/security/env ·
**DGM or MCH** · cross-school/bulk · shared platform code changes.

---

## 4. Kelly's Claude Code setup (point it at the repos)

1. Install Claude Code for Kelly.
2. Create a **workspace folder**; clone **both** repos into it:
   `growth-suite-dashboards/` and `growth-suite-parent-portal/`.
3. Put **`SUPPORT-GUARDRAILS.md` → `CLAUDE.md`** at the workspace root, so it
   loads on top of each repo's own CLAUDE.md.
4. She runs Claude Code **from the workspace root**, on `master` (never a fork).
5. **Credentials decision — flag for this meeting (see §5).**

## 5. The credential question (needs a decision today)

To *reproduce* a school's issue, Kelly's Claude Code needs read access to the
production DB and the school's GHL data — the same power Clint's does. Options:

- **(a) Same creds + propose-only guardrails** — fastest; risk is contained by
  Phase-1 "no writes." Pragmatic start.
- **(b) Read-only DB role / replica for Kelly** — safer; a little setup.
- **(c) A scoped internal "support API"** Kelly's Claude calls instead of raw
  DB/GHL — safest, most work.

Recommendation: **start with (a)** under propose-only, put **(b)** on the roadmap
before Phase 2 (when writes turn on). Decide the appetite in the meeting.

---

## 6. Intake taxonomy → tier (starter — match to the form's dropdowns)

| Ticket type (form dropdown) | Tier | Phase-1 |
|---|---|---|
| "How do I…" / where-is-this | Safe (KB answer, no change) | auto KB reply |
| Form not showing to the right families | Safe (adjust `applies_to`) | propose |
| Need a field shown on a dashboard | Safe (data-catalog add-to-roster) | propose |
| Portal menu wrong for our school | Safe (toggle menu) | propose |
| Data looks stale / out of date | Safe (re-run sync) | propose |
| Parent can't log in | Safe (re-provision portal login) | propose |
| Contact info wrong (name/email/phone) | **Escalate** (fix in GHL) | escalate |
| Invoice / payment / tuition issue | **Escalate** (billing) | escalate |
| "Delete / remove …" | **Escalate** (deletion) | escalate |
| Anything on DGM / MCH | **Escalate** | escalate |
| Novel / not in this list | **Escalate** → becomes a new playbook | escalate |

## 7. Airtable — make Step 8 the engine, not just an archive

Capture per ticket, so the system self-improves:

- ticket_id, school_id, school_name, ticket_type (from taxonomy)
- issue_summary
- **actions_taken** (the actual queries/config changes — before→after), not just "resolved"
- resolved_by (kelly-auto / clint / escalated)
- resolution_verified (yes/no)
- **playbook_id** (which known playbook was used) + **is_novel** (new pattern?)
- customer_reply_sent, time_to_resolve

**The loop:** a novel issue → Clint solves it → we write it up as a **playbook** →
next time the triage AI selects that playbook and Kelly can handle it. That's
how her coverage grows without growing risk. The Airtable `is_novel` flag is the
queue of "playbooks to write."

---

## 8. Open decisions for the two of you (not solved by the docs)

1. **Fix the AI→AI handoff (architecture).** Don't have the context-blind triage
   Claude author *precise Claude Code commands* for a live system it can't see —
   it will hallucinate steps. Have it **classify + select a playbook + hand over
   the verified issue**; Kelly's Claude Code (which has live access) derives the
   exact commands from real state. → *Decide: triage AI outputs a precise prompt,
   or a classified issue + playbook? (Recommend the latter.)*

2. **Escalation channel + Clint's SLA.** How does Kelly escalate (Freshdesk
   reassign? Slack?), and what's Clint's committed response time — or he's the
   bottleneck again, which defeats the purpose. → *Pick a channel + a turnaround
   you'll actually hold.*

3. **Ownership split.** Partner owns the pipeline (N8N / Freshdesk / triage AI /
   KB feeds); Clint owns guardrails / playbooks / escalations / platform fixes.
   → *Write it down so support doesn't drift back onto Clint.*

4. **Data / PII policy.** School + parent data flows Freshdesk → N8N → Claude API
   → Airtable. → *Decide what's allowed where — especially strip student PII
   before it hits the triage Claude / Airtable unless truly needed; set Airtable
   retention.*

5. **Claude API: key, model, cost.** Whose org key + billing owner; model per
   stage (Sonnet triage is fine); rough cost/ticket; rate limits at volume.

6. **Success metrics = the Phase-1→2 gate.** Targets for auto-resolve %,
   escalation %, reopen rate, time-to-resolve, CSAT. → *Graduate a ticket type to
   Kelly-auto on data, not vibes.*

7. **The intake form is load-bearing.** Who builds it; does every dropdown map
   1:1 to a taxonomy tier/playbook; and how do you handle a customer picking the
   **wrong** dropdown (triage AI re-routes / a "not sure" path)?

8. **Hard limits before Phase 2 writes.** The guardrails are *soft* (instructions).
   Before Kelly auto-applies: add a **read-only role** for reproduction, a
   **dry-run → apply** step for writes (reuse the CSV-migration pattern), and
   **one-school scope enforced by the query**, not just the prompt.

9. **"Platform bug, not config" path.** Many tickets are real bugs hitting
   multiple schools. → *Route: flag → Clint's dev backlog (not a per-ticket
   patch) + proactively notify other affected schools.*

## 9. Access & centralization — how Kelly gets "your Claude" as herself

**Reframe:** "My Claude" isn't a login you hand over. Claude Code is a tool that
runs against a **codebase + credentials + knowledge**, authenticated by whoever
is using it. Kelly gets the *same capability* by running **her own** Claude Code
against the **same** repos + knowledge + (scoped) credentials. Nobody shares a
login or an API key. Four layers, each on her own identity:

| Layer | What it is | How to centralize (no shared login) |
|---|---|---|
| **Claude** | Claude Code auth | **Company Claude Team plan** (or an Anthropic Console org) → Kelly gets **her own seat / membership**. Central billing + admin; she logs in as herself. Never share your login or paste your API key. |
| **Code** | The two repos | **GitHub org + team** → add Kelly. Phase 1 she only needs **read** (she's propose-only; escalations go to Clint who commits). Later, push to a **branch via PR** — never direct to `master`. |
| **Credentials** | Prod DB + GHL, to reproduce issues | Distribute via a **secrets vault** (1Password / Doppler), **not** chat/email. Phase 1 = **read-only DB role**. This is the sensitive layer — see the two setups below. |
| **Knowledge** | Guardrails, KB/playbooks, ticket log | Guardrails (`CLAUDE.md`) → **repo**. KB + playbooks → the triage AI's source (Freshdesk KB / Airtable / repo — TBD). **Notion = the per-school ticket + communication log only** (the record, not the brain). |

**⚠️ The gotcha:** the institutional knowledge my Claude has built up lives in
**Clint's local `~/.claude` memory** — it does **not** travel to Kelly's machine.
So the durable knowledge has to move into shared homes: **operational rules →
repo `CLAUDE.md`; support KB + playbooks → Notion.** Otherwise her Claude starts
blind.

**Two setups:**
- **Setup 1 — each on their own laptop (fastest).** Claude Team seat + GitHub
  collaborator + read-only creds from the vault + repo/Notion knowledge. Stand up
  in an afternoon. Downside: prod creds sit on Kelly's laptop.
- **Setup 2 — one company-controlled cloud box / Claude Code cloud workspace
  (the real "centralize it").** Repos + scoped creds + guardrails pre-loaded on a
  box **you** own; Kelly + Clint connect with their **own** accounts; creds never
  leave the box; access revocable instantly. More setup.
- **Recommendation:** start on **Setup 1** for Phase 1 (propose-only = low risk),
  move to **Setup 2 before Phase 2 writes turn on.**

## 10. Notion = the per-school ticket + communication log (behind the scenes)

Notion is **only** the internal customer-service record, organized **per
school** — a searchable history of every ticket and the communication on it.
It is **not** the brain (no playbooks/KB) and customers never see it.

**Structure (two databases):**
- **Schools** — one row per school (name, GHL location id, plan, etc.).
- **Tickets** — one row per ticket, **related to a school**: date, type, summary,
  the communication thread, actions taken (before→after), resolved_by, status,
  is_novel. Filter by school → that school's full history in one place.

**Who writes it:** the triage AI **logs** each new ticket under its school; Kelly
**updates** it as she works; escalations flip a status field. N8N writes to it
via Notion nodes; Kelly's Claude Code can append to it via the Notion connector.

**Where the brain lives (separately):** guardrails → the repo (`CLAUDE.md`);
KB + playbooks → the triage AI's source — **Freshdesk KB / Airtable / repo docs,
TBD** (open item — decide this). Keep it separate from the Notion log.

**Clean split:** **repo = code + guardrails · KB/playbooks = [TBD source] ·
Notion = per-school ticket & communication log.**

## What I can build next (say the word)
- Turn the §6 taxonomy into a real **playbook library** (one tested resolution
  path per safe ticket type) the triage AI selects from.
- A **"resolve location ID → school name + safety summary"** helper Kelly's
  Claude runs as its first step (auto-enforces §1 of the guardrails).
- The **Airtable base schema** (§7) ready to import.
