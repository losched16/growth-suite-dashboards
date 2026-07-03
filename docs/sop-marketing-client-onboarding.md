# SOP — DFY Marketing Client Onboarding (Growth Suite)

**Who this is for:** the internal team member executing onboarding. No prior
knowledge of the system is assumed. Follow the steps in order and check each
box. When a step says "ask Clint," ask Clint — don't guess.

**What this is NOT:** this is the MARKETING onboarding. Do not set up
dashboards, student rosters, the parent portal, or anything admissions-related
— that's a separate product with a separate SOP (`ghl-field-kit.md`).

**Vocabulary:** "Growth Suite" is our white-labeled CRM. A "sub-account" (also
called a "location") is the client's own workspace inside it. "Agency view" is
our master account that contains all clients.

**Timeline at a glance:**
| Phase | What | Target |
|---|---|---|
| 1 | Tech onboarding + snapshot install | Days 1–3 |
| 2 | Messaging (intake form + Tim Seldin call) | Days 3–7 |
| 3 | Copy + creative build | Days 7–10 |
| 4 | Campaign + automation setup | Days 10–14 |
| 5 | Lead magnet + newsletter | Days 10–14 (parallel) |
| 6 | Review with Clint → LAUNCH | Day 14 |

---

## PHASE 0 — Kickoff (Day 1)

- [ ] **0.1** Confirm the signed agreement + intake email from Clint containing:
      school name, contact person, email, phone, website URL, and ad budget.
- [ ] **0.2** Create a client folder in our shared drive named
      `Clients/<School Name>/` with subfolders: `Photos`, `Copy`, `Creative`,
      `Access`, `Reports`.
- [ ] **0.3** Send the client the **Welcome + What To Expect** doc
      (`marketing-client-expectations.md` → PDF) and the **access checklist**
      (what we need from them — listed in that doc).

---

## PHASE 1 — Tech Onboarding (Days 1–3)

### 1.1 Create the sub-account (with the snapshot — this IS the install)

**Who does this: YOU (the onboarding tech).** The snapshot is built and
maintained by Clint; you only ever *apply* it.

1. Log into Growth Suite **Agency view** (ask Clint for your login if you
   don't have one).
2. Left sidebar → **Sub-Accounts** → click **+ Add Sub-Account** (top right).
3. Choose **"Add from Snapshot"** (NOT "blank").
4. In the snapshot picker, select: **`[GS Marketing Snapshot — ask Clint for
   the exact current name]`**.
5. Fill in the business details: school name, address, phone (their main
   line for now), website, timezone (**use the school's timezone — get this
   right, it drives appointment times**).
6. Click **Save / Create**. Wait for the snapshot to finish loading (can take
   a few minutes — the account will populate with pipelines, workflows,
   funnels, and email templates).

**What the snapshot installs (so you can verify it loaded):**
- **Pipeline:** "Marketing / Tour Pipeline" with stages (New Lead → Contacted
  → Tour Booked → Tour Completed → Application Started → Won / Lost)
- **Workflows:** tour-booking confirmation + reminders, no-show follow-up,
  speed-to-lead new-inquiry sequence, tagging/opportunity automation
- **Funnels:** "Schedule a Tour" landing page template, quiz page template
- **Calendar:** "School Tour" calendar template
- **Email templates:** booking confirmation, reminders, nurture sequence,
  weekly newsletter shell
- **Custom fields + tags** used by the above

> ✅ **Verify:** open the new sub-account → Automation → you should see the
> workflows listed. Open Sites → Funnels → you should see the funnel
> templates. If the account looks empty, the snapshot didn't apply — redo
> step 3–4, or (for an already-created account) Agency view → Sub-Accounts →
> find the account row → three-dot menu → **Load Snapshot** → pick the
> snapshot → confirm.

### 1.2 Connect the calendar

1. Inside the client's sub-account → **Settings → My Staff** → add the
   school's tour-giver as a user (their name + email) if not already there.
2. That user (or the client on a screen-share) connects their Google/Outlook
   calendar: **Settings → My Staff → Edit user → Calendar Configuration →
   Connect** → sign into their Google account → allow.
3. **Settings → Calendars** → open the "School Tour" calendar (from the
   snapshot) → assign the connected user → set their real availability
   (ask the client: which days/times do you give tours?) → Save.
4. **Test it:** open the calendar's booking link in an incognito window, book
   a fake tour for tomorrow, confirm it appears on their Google calendar.
   Then cancel/delete the test booking.

### 1.3 Connect socials

1. Sub-account → **Marketing → Social Planner** → **Connect** → Facebook →
   log in as the client (screen-share or their credentials from the access
   checklist) → select their Facebook **Page** and **Instagram** account →
   allow all permissions.
2. ✅ Verify: both the FB page and IG account show "Connected."

### 1.4 Connect ad account in Plai

1. Log into **Plai** (team login — ask Clint).
2. Add the client: connect their **Facebook Ad Account** (they must grant
   access — send them Plai's connect link or do it on a screen-share; if
   they've never run ads, help them create an ad account in Meta Business
   Manager first, with their card on file — **ad spend always bills to the
   client's card, never ours**).
3. Link Plai to the client's Growth Suite sub-account (Plai → integrations →
   select the location), so leads from ads flow into the CRM.
4. ✅ Verify: Plai shows the ad account with a green/connected status.

### 1.5 Subdomain (for funnels + quiz)

1. Decide the subdomain with the client — default: **`go.<theirschool>.com`**.
2. Client (or their web person) adds a DNS record: **CNAME `go` →
   `sites.ludicrous.cloud`** *(confirm the exact CNAME target shown in the
   next step — GHL displays it)*.
3. Sub-account → **Settings → Domains → Add Domain** → enter
   `go.<theirschool>.com` → follow the verification prompt (it shows the
   exact record to give the client if 2 wasn't done yet).
4. ✅ Verify: domain shows "Verified." Set it as the default funnel domain.

### 1.6 Dedicated sending (email) domain

1. Sub-account → **Settings → Email Services → Dedicated Domain** → Add →
   use **`mail.<theirschool>.com`**.
2. GHL displays DNS records (SPF/DKIM/tracking). Send them to the client's
   web person in one email — copy them exactly.
3. ✅ Verify: come back after DNS propagates (up to 24h) → status "Verified."
   **Do not send any email campaigns until this is green** — deliverability
   depends on it.

### 1.7 Phone system

1. Sub-account → **Settings → Phone Numbers → Add Number** → buy a **local**
   number matching the school's area code.
2. **A2P registration (required for texting in the US):** Settings → Phone
   Numbers → Trust Center → complete the A2P 10DLC brand + campaign
   registration using the school's legal business info (get their EIN from
   the access checklist). This can take days to approve — **start it on Day
   1.** No SMS goes out until approved.
3. Set the number's forwarding to the school's front-desk line so missed
   calls ring through.
4. ✅ Verify: call the new number → it rings the school. Send a test SMS
   once A2P is approved.

> **Phase 1 exit checklist:** snapshot verified · calendar books to Google ·
> socials connected · Plai connected · subdomain verified · sending domain
> verified (or pending DNS) · phone bought + A2P submitted.

---

## PHASE 2 — Messaging (Days 3–7)

### 2.1 Send the messaging intake form

1. Send the client the **Messaging Intake Form** link
   `[link — ask Clint where the current form lives]` the same day tech
   onboarding starts. Tell them it must be completed **before** the Tim call.
2. Chase at 48h if not completed (call, don't just email).

### 2.2 Book the messaging call with Tim Seldin

1. Book a 60-minute call: client decision-maker(s) + Tim Seldin
   `[Tim's scheduling link — ask Clint]`. Aim for within week one.
2. **Record the call** (Zoom cloud recording ON) and get the transcript.
3. Save the recording + transcript to `Clients/<School>/Copy/`.

### 2.3 Collect photos (do this in parallel — it's the #1 bottleneck)

1. Ask the client for **15–20 photos**: classrooms in use, kids working
   (faces OK only if they confirm media releases), outdoor spaces, teachers,
   the building exterior. Real photos beat stock — insist.
2. Save to `Clients/<School>/Photos/`.

---

## PHASE 3 — Copy + Creative Build (Days 7–10)

We use **Claude** for all copywriting. Inputs: the intake form answers + the
Tim Seldin transcript. Never write from a blank page and never let Claude
write without those two inputs.

### 3.1 Build the copy pack with Claude

1. Open a new Claude chat. Paste this prompt, then paste the full intake
   form answers and the full transcript below it:

   > You are writing direct-response marketing copy for a Montessori school.
   > I'm giving you (1) their messaging intake form and (2) a transcript of a
   > positioning call with a Montessori expert. Using ONLY what's in these
   > sources (no invented claims, no made-up numbers), produce:
   > 1. FOUR Facebook/Instagram ad copy variations for a "Schedule a Tour"
   >    campaign: TWO using the PAS framework (Problem–Agitate–Solution) and
   >    TWO using AIDA (Attention–Interest–Desire–Action). Each: headline
   >    (<40 chars), primary text (~80–125 words), and CTA line. Audience:
   >    local parents of children ~1–6 years old. Tone: warm, credible,
   >    zero jargon.
   > 2. LANDING PAGE copy for the tour page: hero headline, subheadline,
   >    3 benefit blocks, "what to expect on your tour" section, 3 FAQ
   >    entries, and a CTA section.
   > 3. A 5-email POST-BOOKING sequence (see structure below) — confirmation,
   >    day-before reminder, day-of reminder, post-tour thank-you + next
   >    step, and a no-show recovery email. Subject lines + body for each.
   > 4. A 5-email NURTURE sequence for leads who did NOT book: one email
   >    every 3 days, educational-first, each ending with a soft tour CTA.
   > Flag anything where you lacked source material with [NEEDS INPUT].

2. Read the output. Fix anything that contradicts the intake (you are the
   quality check — Claude doesn't know the school; the documents do).
3. Save as `Copy Pack v1 — <School>.docx` in `Clients/<School>/Copy/`.
4. **Send to Clint for approval. Do not skip.** Revise once, get sign-off.

### 3.2 Create the 5 ad images with ChatGPT

1. Pick the 8–10 best client photos from `Photos/`.
2. In ChatGPT (image generation), create **at least 5 ad creatives** using
   the school's real photos as the base — typical set:
   - 2 × photo-forward with text overlay (headline from the ad copy)
   - 1 × "what parents say" quote card (real quote from intake/reviews)
   - 1 × "Schedule Your Tour" CTA card with school logo + colors
   - 1 × seasonal/urgency variant ("Now enrolling for fall")
3. Export each in **1080×1080** AND **1080×1920** (feed + story sizes).
4. Save to `Clients/<School>/Creative/`. Get client sign-off on images that
   include children's faces.

---

## PHASE 4 — Campaign + Automation Setup (Days 10–14)

### 4.1 Landing page

1. Sub-account → **Sites → Funnels** → open the snapshot's "Schedule a Tour"
   funnel → **clone it** (never edit the template directly).
2. Replace all placeholder text with the approved landing page copy, swap in
   client photos/logo/colors, point the calendar widget at the "School Tour"
   calendar from 1.2.
3. Set the funnel URL on the client subdomain (from 1.5), e.g.
   `go.<theirschool>.com/tour`.
4. ✅ Test: submit the form + book a test tour on your phone. Confirm the
   booking hits the calendar and the contact appears in the CRM.

### 4.2 Launch ads in Plai

1. In Plai, create the "Schedule a Tour" campaign for the client:
   - Objective: leads/conversions to the landing page
   - Radius: ~8–15 miles around the school (confirm with client)
   - Audience: parents, ages ~25–45 (Plai's parenting presets)
   - Budget: per the agreement (from Phase 0 email)
2. Load **all 4 ad copy variations** and **all 5 images** — Plai/Meta will
   optimize the combinations.
3. Set the ads to send leads to the landing page URL from 4.1.
4. **Do not press publish until Clint has approved the whole campaign** (4.4).

### 4.3 Automations: booking emails, tagging, opportunities

The snapshot ships these workflows — your job is to open each one, replace
template copy with the approved copy pack, and turn it ON:

1. **Automation → Workflows → "Tour Booked — Confirmation + Reminders"**
   - Trigger: appointment booked on the School Tour calendar
   - Actions to verify: send confirmation email (paste approved copy) →
     wait → day-before reminder → day-of SMS (only if A2P approved) →
     **add tag `tour-booked`** → **create/move Opportunity to "Tour Booked"
     stage in the Marketing/Tour Pipeline**
2. **"New Lead — Speed to Lead"**
   - Trigger: form submitted on the landing page
   - Verify: **add tags `lead`, `source-fb-ads`** → **create Opportunity in
     "New Lead" stage** → notify the school (email to their front desk) →
     start the nurture sequence (paste approved nurture emails)
3. **"No-Show Recovery"** — trigger: appointment status = no-show → paste
   the approved no-show email → tag `no-show`.
4. **"Post-Tour Follow-Up"** — trigger: appointment completed → thank-you +
   next-step email → move Opportunity to "Tour Completed."
5. Flip each workflow to **Publish/Active** and run one end-to-end test with
   your own email + phone: fake lead → nurture starts → book → confirmation
   arrives → opportunity card moves. Delete your test contact afterwards.

### 4.4 Pre-launch review with Clint (GATE — nothing goes live without this)

Walk Clint through: landing page on the live subdomain, the 4 ads + 5 images
in Plai (in draft), each workflow, and one test booking. Fix notes, then
**publish the ads.** Record the launch date in the client folder.

---

## PHASE 5 — Lead Magnet + Newsletter (parallel with Phase 4)

### 5.1 "Is Montessori Right For Me?" quiz

1. Get the quiz code from Clint `[stored: ask Clint — it exists from a
   previous build]`.
2. Sub-account → **Sites → Funnels** → clone the snapshot's quiz page →
   delete placeholder content → add a **Custom JS/HTML element** → paste the
   quiz code.
3. Wire the quiz's completion to the CRM: the quiz should submit
   name/email into a GHL form or webhook *(the code includes this — if the
   endpoint/form ID needs setting, ask Clint which value to use)*.
4. Create/verify workflow **"Quiz Completed"**: trigger on that form/webhook
   → **tag `quiz-lead`** → deliver results email → start nurture sequence →
   create Opportunity in "New Lead" (source: quiz).
5. Publish at `go.<theirschool>.com/quiz`, take the quiz yourself end to
   end, confirm the tag + email + opportunity all fire. Delete your test.

### 5.2 Weekly newsletter setup

1. Sub-account → **Marketing → Emails → Templates** → open the snapshot's
   "Weekly Newsletter" template → clone → brand it: school logo, name,
   colors, footer with their address (legally required).
2. Structure (already in the template): intro note from the school → **1
   featured article** → school announcements block → tour CTA button.
3. Save as `<School> — Weekly Newsletter`.

### 5.3 Blog content library (the weekly article)

1. The article library lives at `[location — ask Clint: the Growth Suite
   blog/content library]`. One article gets featured per week.
2. **Weekly recurring task (every Monday, 30 min):**
   - Pick the next unused article from the library (keep a used-articles
     log in the client folder)
   - Paste the title, 2–3 sentence teaser, and "Read more" link into the
     newsletter template
   - Update the announcements block (ask the school for anything new — a
     standing Friday email to them works)
   - Schedule the send for **Tuesday 10:00 AM school-local time** to the
     appropriate list (their parent/lead list — confirm the audience with
     the school during onboarding; never blast purchased lists)
3. First send: get Clint's approval on newsletter #1 before scheduling.

---

## PHASE 6 — Handoff to steady state

- [ ] All Phase 1–5 boxes checked; launch date recorded
- [ ] Weekly recurring tasks on your calendar: Monday newsletter build,
      weekly ad-performance glance in Plai (flag to Clint if cost-per-lead
      doubles or leads stop for 3+ days)
- [ ] Client knows their weekly rhythm (see the expectations doc)
- [ ] Send the client the "You're live!" email: links to their landing page,
      quiz, and what happens next

## Escalation rules (when to stop and ask Clint)

- Anything involving **money** (ad budget changes, billing)
- The client asks for **admissions software** things (dashboards, rosters,
  parent portal, enrollment forms) — that's the other product
- DNS/domain steps fail after one retry
- A2P registration is rejected
- The client is unresponsive for 5+ business days
