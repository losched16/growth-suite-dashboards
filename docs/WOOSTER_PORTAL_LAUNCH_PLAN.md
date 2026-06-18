# Wooster Portal Launch — GHL workflow + email plan

**Goal:** Get all 340 Wooster parents (out of 342 — 2 already have
passwords) into the parent portal with a welcome email that lands in
their inbox and a one-click "set my password" link.

**Status as of plan-write:**
- 297 students · 208 families · 342 parents
- **2 / 342 parents have set a portal password** — basically nobody
  has signed in yet
- Wooster's `school_branding.email_provider` = `'ghl'` (flipped today)
  → every email from our system goes through Wooster's GHL location +
  `mail.woomontessori.org` sending domain
- 8 published parent forms; notification recipient lists currently empty

---

## 1. The welcome email — copy

Single send to all 340 no-password parents. The CTA goes to the
parent portal login page, where they enter their email + we send a
magic link (one-time, expires in 15 min). After they click the link
they're prompted to set a password.

**Subject:**
```
Set up your Wooster parent portal — start of school is around the corner
```

**Body (HTML, but renders fine as plain text):**
```
Hi {{contact.first_name}},

The Montessori School of Wooster is rolling out a new parent portal
this year, and your account is ready.

In the portal, you can:
  • Submit enrollment paperwork (Emergency Medical, Health History,
    Media Permission, and the rest of our 8 required forms)
  • Track which forms are still pending for each of your children
  • Update your contact info, your emergency contacts, and your
    authorized pickup list
  • See your tuition statement and pay invoices online

Setting up your account takes 60 seconds:

  1. Click the button below
  2. Enter the email address this message was sent to
  3. We'll send you a one-time sign-in link — click it, set a password,
     and you're in

  → https://family.woomontessori.org/login

Questions? Reply to this email or call the office at (330) XXX-XXXX.

Looking forward to a great year,
The Wooster team
```

Replace the office phone number when you send.

**Plain-text fallback:** the same body, no formatting. GHL's
Conversations API includes both when sending Email-type messages.

---

## 2. GHL workflow shape

### Smart list / segment to target

Inside Wooster's GHL location:

```
Contacts → Smart Lists → Create new
Name: "Parents without portal password"

Filter:
  contact.tags  contains  "msw_parent"           ← every Wooster parent
  AND
  contact.custom_field "portal_password_set_at"  is empty
```

The `portal_password_set_at` custom field doesn't exist yet — we
need to create it AND start writing to it when parents set their
password. See "Implementation work" below.

### The workflow

```
Wooster GHL → Automation → Workflows → Create new
Name: "Parent portal welcome — initial rollout"

Trigger: Manually added (run once on the smart list)
  OR
Trigger: Contact created  AND  tags contains "msw_parent"
        (for ongoing new-parent onboarding)

Actions:
  1. Send Email
     - From: Montessori School of Wooster <noreply@mail.woomontessori.org>
     - Reply-To: admissions@woomontessori.org
     - Subject: (from above)
     - Body:    (from above)
  2. Wait 7 days
  3. If contact custom field "portal_password_set_at" is STILL empty:
       - Send reminder email (shorter, "still haven't set up yet?")
  4. Wait 7 days
  5. If still empty:
       - Add task for office: "Call {{contact.first_name}} {{contact.last_name}} re: portal setup"
       - (Stops the auto cadence — humans take over)
```

---

## 3. Implementation work for me (Clint)

Before flipping the workflow on, two things need to ship from our
side. Both are small.

### A. Write `portal_password_set_at` back to GHL

When a parent sets their password (first sign-in flow), write the
timestamp into their GHL contact's `portal_password_set_at` custom
field. Without this, the smart list never narrows — every parent
stays in it forever.

**Files to touch (parent-portal repo):**
- `lib/auth/password.ts` (or wherever `setPassword` lives — search
  for `password_hash` writes)
- After the UPDATE to `parents.password_hash`, fire a GHL contact
  update via the existing writeback helpers in `lib/ghl/`
- Idempotent — if Wooster's GHL location doesn't have the custom
  field defined yet, the API call silently no-ops

### B. Tag every Wooster parent with `msw_parent`

Probably already done via the sync that pulls parents in from GHL,
but verify by checking 5 sample contacts in GHL after the sync
runs. If not, one-time tag-add SQL → GHL fan-out.

### C. Populate `notify_emails` on each Wooster form

The notifications toggle in the Forms tab is wired but the recipient
lists are empty on all 8 forms (so the toggle is currently a no-op).
Wooster's reply-to is `admissions@woomontessori.org` — easiest to
default ALL 8 forms to that recipient, and Wooster can split out per
form later (e.g. health forms → nurse). One SQL update + re-cache.

---

## 4. Wooster-side prep (Sonia / their admin)

Before sending, ask Wooster admin to:

- [ ] Verify `mail.woomontessori.org` sending domain is **verified +
      warmed up** in their GHL (Settings → Email Services). A new
      domain can have bad deliverability for 1-2 weeks.
- [ ] Confirm the office phone number to paste into the email body
      (we left a placeholder).
- [ ] Identify the right human to staff the "parents who didn't set
      up after 14 days" task list — usually the front desk.
- [ ] Confirm the smart list of "Wooster parent" contacts in GHL is
      accurate (cross-check the count against 340).

---

## 5. Rollout cadence — recommended

**Don't** mass-send to all 340 on day one. New sending domains hit
spam filters when blasted cold.

```
Day 1:   Send to a soft-launch cohort — 20 most-engaged families
         (Sonia picks). Confirm delivery (ask them to check inbox).
Day 3:   If delivery looked clean, send to next 80 families.
Day 5:   Send to the remaining 240 families.
Day 7:   First-reminder branch of the workflow fires automatically
         (per the 7-day wait step above).
Day 14:  Second-reminder branch fires; humans pick up calls.
```

Tweak in GHL's "Bulk Action" tool by manually narrowing the smart
list to each cohort.

---

## 6. What "ready to go" actually means

After all three implementation items (A, B, C) ship:

✅ A parent gets the welcome email from `noreply@mail.woomontessori.org`
✅ They click → land on parent portal login → enter their email →
   magic link arrives → they click → set password → land on home
✅ Their `portal_password_set_at` custom field in GHL is updated
   automatically — the smart list shrinks
✅ Form submissions from then on trigger the email notification to
   `admissions@woomontessori.org` (or whichever address you set)
✅ Drafts vs Published, per-form notify toggle, all manageable from
   the embedded Forms tab inside Wooster's GHL

---

*Saved at `docs/WOOSTER_PORTAL_LAUNCH_PLAN.md`. Pings welcome.*
