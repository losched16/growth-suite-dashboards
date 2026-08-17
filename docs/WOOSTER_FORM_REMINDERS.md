# Wooster — Automated Form Reminders

Live as of 2026-08-17. Runs itself; nothing for the office to do.

## The schedule

| Setting | Wooster value |
|---|---|
| Who gets reminded | Any family with at least one **enrolled** student that still owes one or more portal forms |
| First reminder | Next 9:00 AM Eastern after the family becomes eligible (for the current backlog: tomorrow morning, 2026-08-18) |
| Repeat | Every **7 days** while forms are still outstanding |
| Stops when | The family finishes every form, **or** after **6** reminders — whichever comes first |
| Send time | **9:00 AM America/New_York**, daily check |
| Recipients | Every active parent on the family who has an email (Parent 1 and Parent 2 both get their own copy) |
| Sent from | Wooster's GHL sending domain (same as all other portal email) |
| Reply-to / questions | woomontessori@woomontessori.org |

**Tomorrow's first run:** ~85 families, ~90 emails.

## What the email says

Subject: `Reminder: N forms still needed — Montessori School of Wooster`

- Greets the parent by first name.
- Lists exactly which forms are outstanding — for per-student forms it names the child(ren): *"Health History — for Garrett, Jensen"*.
- One big **Open my forms** button. It's a one-click sign-in link (no password), good for 7 days, reusable — clicking it lands the parent directly on their checklist.
- Notes that if they finished in the last day or two they can ignore it.
- Signs off with the school's support address.

## Who is deliberately NOT reminded

- **Withdrawn families** — never.
- **Admissions-pipeline prospects** (Interest / Tour / Documents Requested with no enrolled student yet) — never. Only enrolled families are on the hook for enrollment paperwork.
- **Families who finished in the old Final Forms system** (e.g. Cosgriff) — the reminder honors the same GHL-side completion signals the Portal Forms Tracker does, so it sees them as complete.
- A withdrawn **sibling** in an otherwise-enrolled family doesn't keep the family "owing."
- Anyone whose family has **no email on file** (they simply can't be reached — those show on the tracker for a phone call).

## Where to see what was sent

Every send is logged (`form_reminder_log`): family, parent, email, reminder # (1–6), which forms were outstanding, sent/failed. Ask Clint for a pull, or it can be surfaced as a dashboard column if useful.

## Changing the schedule

All per-school, one row in `school_branding` — no code:

| Column | Meaning |
|---|---|
| `reminders_enabled` | on/off switch |
| `reminder_interval_days` | days between reminders (7) |
| `reminder_max_count` | stop after N (6); NULL = never stop while owing |
| `reminder_send_hour_local` | 0–23 local hour (9) |
| `reminder_timezone` | IANA zone (America/New_York) |
| `reminder_honor_ghl_completion` | count old-system completions as done (true) |

## Mechanics (for Clint)

- Portal repo: `lib/forms/pending.ts` (single "what's owed" definition, shared with the home checklist), `lib/forms/reminders.ts` (cadence + email), `app/api/cron/form-reminders/route.ts` (hourly Vercel cron; sends only when a school's local hour matches). Migration `013_form_reminders.sql`.
- Cron auth is the portal's `CRON_SECRET` (Vercel Sensitive var — injected automatically for scheduled runs; can't be pulled locally). Manual ops: `?dry=1` (count only), `?force=1` (ignore hour), `?school=`, `?family=`.
- Local dry-run: `npx tsx --env-file=.env.local scripts/dry-run-wooster-reminders.mjs`
- Verified 2026-08-17: hour-gate holds outside 9am; forced dry-run 146 enrolled families scanned → 85 owing → 85 emails, 0 errors; Cosgriff (legacy completions) correctly 0 owed.
