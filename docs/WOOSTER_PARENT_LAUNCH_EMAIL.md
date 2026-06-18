# Wooster — parent launch email

Joe asked on 2026-06-15 that this go to **every** Wooster parent, not
just the ones missing forms. Two reasons: (1) the portal is also
where they'll come for ongoing changes, so they should know where it
lives, and (2) we updated several forms since last year, so even
completed parents may want a second look.

Tone: matter-of-fact, friendly, no urgency for already-done parents
but with a soft "if anything is red, please get it in" cue.

---

## 1. Initial blast (all 340 parents)

**From:** `Montessori School of Wooster <noreply@mail.woomontessori.org>`
**Reply-To:** `woomontessori@woomontessori.org`
**Subject:** Your Wooster Family Portal is ready — a simpler home for everything

**Body:**

```
Hi {{contact.first_name}},

For the last few years, Wooster paperwork has lived in a handful of
places — Final Forms, separate sign-up links, paper handouts — and
we know it hasn't always been easy to remember where to go for what.

We're bringing all of it under one roof this year. Meet the new
Wooster Family Portal: one login for your whole family, every form
and family record in one place, and everything you've already
submitted is already there waiting for you.

Sign in here:

  → https://portal.woomontessori.org/login

(Enter the email this message was sent to, click "Continue," and set
a password the first time. That's the only step you'll need to take
to get in.)

What's better about it:

  • One URL — no more hunting for the right form link in an old email
  • One login per parent — set a password once, you're in any time after
  • Everything pre-filled — your past submissions carry over, you just
    confirm or update what's changed
  • You can see what's done — every form has a green check when complete,
    so it's easy to spot what (if anything) is still needed
  • Updates land instantly — change a phone, an emergency contact, or a
    pickup person once and the office sees it right away

What stays the same:

  • The forms themselves — same questions, same fields
  • Your data — everything you submitted in past years carried over
  • Who you contact — the office is still woomontessori@woomontessori.org
    or (330) 264-8666

If everything in your account is green, you're already set. Just
bookmark the portal for when you need to update something during the year.

If something is yellow or red, please take a few minutes to wrap it up
so we have everything we need for the start of school.

Thanks for your patience as we make this transition — we think you'll
find it a lot easier.

The Wooster team
```

**Plain-text version:** the body above — no formatting changes needed,
already reads cleanly.

---

## 2. Reminder branch — for parents who haven't signed in after 7 days

Same workflow, fires automatically when `portal_password_set_at` is
still empty 7 days after the first email.

**Subject:** Still need a minute — Wooster portal sign-in

**Body:**

```
Hi {{contact.first_name}},

Just a friendly reminder — we sent your sign-in link for the
Wooster Family Portal a week ago, and we don't see you in there yet.

It's a 60-second setup:

  1. Open https://portal.woomontessori.org/login
  2. Enter this email address — we send a one-time sign-in link
  3. Click the link in your inbox, set a password, you're in

Once you're in, anything still red or yellow on your family record
is something we need before the school year starts. Most of you have
3-4 forms left.

Reply to this email if you're stuck — happy to help.

The Wooster team
```

---

## 3. Reminder branch — for parents still missing forms after 14 days

Workflow logic: triggers when password IS set but the family still has
unsigned forms.

**Subject:** A few forms still needed for {{contact.first_name}}

**Body:**

```
Hi {{contact.first_name}},

Thanks for setting up your portal account. Looking at your family
record, we still have a few forms outstanding:

→ https://portal.woomontessori.org/home

Whatever shows yellow or red on your Home page is what we still need.
Each form takes 2-5 minutes — most info will pre-fill from what you
submitted in past years.

Let us know if anything looks wrong or if you have questions about
what a particular form is asking for.

The Wooster team
```

---

## GHL workflow shape

Inside Wooster's GHL workspace:

```
Automations → Workflows → New
Name: "Parent portal — launch + nudges"

Trigger:
  Manual / Bulk-add from the smart list "All Wooster Parents"
  (Set up the smart list under Contacts → Smart Lists with
   filter: tag contains 'msw_parent')

Steps:
  1. Send Email — Initial blast (above)
  2. Wait 7 days
  3. IF custom field portal_password_set_at IS empty
       → Send Email — 7-day reminder (above)
  4. Wait 7 days
  5. IF custom field portal_password_set_at IS NOT empty
       AND family has unsigned forms (see below)
       → Send Email — 14-day "forms still needed"
  6. IF still no password after 14 days total
       → Create task for office: "Call {{first_name}} re: portal"
```

> For step 5, "family has unsigned forms" is harder to gate on inside
> GHL since the GHL contact doesn't know which forms are missing.
> Recommendation: skip the conditional and send to everyone in the
> branch — the email's "whatever shows yellow or red" language reads
> fine for someone who happens to be all green.

---

## Rollout cadence

Don't blast all 340 on day one. New sending domains hit spam filters
when blasted cold.

```
Day 1:  Soft launch — 20 most-engaged families (Sonia picks).
        Confirm delivery (text/call 2-3 of them to check inbox).
Day 3:  If clean, send to next 80.
Day 5:  Send to remaining 240.
Day 12: 7-day reminder fires automatically for slow movers.
Day 19: 14-day reminder fires for parents who haven't finished forms.
```

---

## Pre-send checklist

Before flipping the workflow on:

- [x] All 9 forms have `notify_emails` set to `woomontessori@woomontessori.org` (done 2026-06-16)
- [x] `portal_password_set_at` writeback to GHL is live (done earlier this week)
- [x] Wooster's `email_provider = 'ghl'` so emails route through `mail.woomontessori.org`
- [ ] Verify `mail.woomontessori.org` is **verified + warmed up** in GHL settings
- [ ] Confirm the office phone number in the body (currently 330-264-8666 — Joe to confirm)
- [ ] Identify the right human to staff the "didn't sign up after 14 days" task list

---

*Saved at `docs/WOOSTER_PARENT_LAUNCH_EMAIL.md`. Update the date
stamps above when you revise.*
