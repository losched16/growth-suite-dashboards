# Making GHL the source of truth for Wooster

Goal: when Wooster admin edits a contact in GHL — name, email, phone,
custom-field student-slot data, tags — that change shows up in every
dashboard, **fast**. No "sync" button. No reload-and-pray. Admin
brings in a new family on a Monday morning, the dashboards reflect
that family the same morning.

## Architecture: two channels

Both run automatically. Together they cover every change.

### Channel 1 — Realtime webhook (already-known contacts)

GHL workflow fires our webhook on every contact change. We fetch the
canonical record from GHL and overwrite the parent / student / family
rows. Latency: **1–5 seconds** from the change happening in GHL to
the dashboards reflecting it.

Covers:
- A parent's name / email / phone changes
- Any per-student custom field changes (`student_first_name`,
  `student_2_last_name`, etc.)
- The family display name auto-updates from the parent's name

### Channel 2 — Periodic cron sync (everything else)

Vercel Cron hits `/api/cron/sync-all` **every 15 minutes** (was every
2 hours; tightened in the same commit as this doc). For every
school with `sync_mode='snapshot'` (Wooster is one), the cron:

- Pulls **every contact** from GHL and rebuilds the family graph
  (creates new families, new students, new parents as needed)
- Syncs the attribute layer (tags + custom field values +
  opportunities + filter catalog)

Covers what the webhook can't:
- **New contacts** added in GHL show up in dashboards within 15 min
- **Tag changes** propagate (the webhook only handles row updates,
  not the tag layer)
- **Pipeline / opportunity stage changes** roll up to the admissions
  funnel
- A missed webhook (network blip, GHL outage) is eventually caught

The two channels overlap — same change might land twice — but every
write is idempotent so no harm done.

This is half code and half configuration. The code shipped in this
session. The configuration is a one-time setup inside Wooster's GHL
workspace, documented below.

---

## What the code does (already deployed)

Inbound webhook at:
```
POST https://growth-suite-dashboards.vercel.app/api/webhooks/ghl/contact
```

On every webhook event (`ContactCreate` / `ContactUpdate`):

1. **Verifies auth** — either HMAC signature OR static bearer token.
2. **Fetches the canonical contact from GHL** via `/contacts/<id>` —
   so the payload's field set doesn't matter; we pull the whole
   record.
3. **Updates the parent row**: first_name / last_name / email / phone.
4. **Cascades last-name changes to students** that currently share
   the parent's OLD surname. Blended-family students with a different
   surname are left alone.
5. **Updates per-student rows** from the contact's custom-field
   slots — `student_first_name`, `student_last_name`,
   `student_2_first_name`, `student_2_last_name`, etc. — mapped via
   `ghl_attributes_catalog`.
6. **Refreshes the family display_name** to "FirstName LastName" of
   the primary parent.
7. **Logs** to `ghl_webhook_log` so we can audit every event after
   the fact.

If GHL is briefly down or rate-limited, the webhook falls back to
applying whatever's in the payload — better to capture a partial
update than miss it entirely.

---

## What you (or Sonia) need to set up in GHL

You'll create ONE workflow in Wooster's GHL workspace that fires our
webhook every time a contact changes.

### Step 1 — Decide the auth method

Easiest: **static bearer token**. Pick a long random string (use any
password generator — 32+ chars). Save it in **two places**:

- **Our side**: Vercel → growth-suite-dashboards project → Settings →
  Environment Variables. Add:
  ```
  GHL_WEBHOOK_SECRET = <your-random-string>
  ```
  Redeploy after saving.
- **GHL side**: you'll paste the same string into the workflow header
  in step 3.

(HMAC signing is supported too if you'd rather sign — same env var
holds the secret. The webhook checks HMAC first, falls back to static
bearer. But Workflow Custom Webhooks can't compute HMAC, so static
bearer is the realistic choice.)

### Step 2 — Open Wooster's GHL workflow builder

1. Log into Wooster's GHL workspace (location `tFP5UnlBYQayjettNeuG`)
2. **Automation → Workflows → Create new workflow**
3. Name it something like: `Growth Suite — sync contact changes`

### Step 3 — Configure the workflow

**Trigger:** "Contact Changed"
- Select **all** of these triggers (one workflow per trigger, or use
  the multi-trigger composite):
  - **Contact Created**
  - **Contact Updated** (most important — fires on any field change)
  - **Contact Tag** (added/removed) — optional, only if you care about
    tag changes flowing into dashboards
  - **Note Added** — skip unless we wire note-syncing later

**Action:** "Webhook"
- **URL**: `https://growth-suite-dashboards.vercel.app/api/webhooks/ghl/contact`
- **Method**: `POST`
- **Headers**: add one header:
  - Key: `x-webhook-token`
  - Value: the random string you put in `GHL_WEBHOOK_SECRET`
- **Body**: pick **JSON** and include at minimum:
  ```json
  {
    "type": "ContactUpdate",
    "locationId": "{{location.id}}",
    "contactId": "{{contact.id}}",
    "webhookId": "{{workflow.execution_id}}"
  }
  ```

  The merge tokens in `{{...}}` are GHL workflow variables — leave them
  as-is, GHL fills them in at send time. The body is intentionally
  minimal: we fetch the full contact from GHL anyway, so we only need
  the IDs to know which one to look up. `webhookId` is used for dedup
  on retries.

  (If you'd like more fields in the payload as a backup, you can add
  `firstName`, `lastName`, `email`, etc. — they'll be used as a
  fallback if the canonical fetch fails. Not required.)

### Step 4 — Publish + test

1. **Save and publish** the workflow.
2. **Test fire**: in the workflow builder, use the "Test workflow"
   feature with any real Wooster contact. Or just edit a contact's
   first name in the GHL contact view and save — that's a real
   `ContactUpdate` event.
3. **Verify** in our database:
   ```
   node -e "...query('SELECT ... FROM ghl_webhook_log WHERE school_id = ... ORDER BY received_at DESC LIMIT 5')..."
   ```
   You should see a row with `status='applied'` and `rows_affected>0`.

   Or simpler: refresh the Portal Forms Tracker — if the contact's
   name change is reflected in the family row, the loop is closed.

---

## What's now end-to-end real-time

After setup:

| GHL change | Reflected in dashboards |
|---|---|
| Contact's first/last name | parent's name in Family Hub / Tracker / inbox |
| Contact's email | parent_email column everywhere |
| Contact's phone | parent_phone in family detail |
| Student slot custom field (e.g. `student_2_last_name`) | matching student row's last_name |
| Last-name change | cascaded to students sharing the OLD surname |
| Family display name | "FirstName LastName" of primary parent |

---

## What each channel covers

| Change in GHL | Covered by | Lag |
|---|---|---|
| Existing parent: name / email / phone | Webhook | 1–5 seconds |
| Existing student: name (via custom-field slot) | Webhook | 1–5 seconds |
| Family display name auto-refresh | Webhook | 1–5 seconds |
| **NEW contact added in GHL** | **15-min cron** | ≤ 15 min |
| Tags added/removed on contact | 15-min cron (attribute layer) | ≤ 15 min |
| Custom-field catalog changes | 15-min cron (attribute layer) | ≤ 15 min |
| Pipeline / opportunity stage moves | 15-min cron (admissions funnel) | ≤ 15 min |
| Contact deletion in GHL | **Not synced** (intentional — keep history) | — |

If 15 min is too slow for new contacts, we can:
- Drop the cron to every 5 min (8 cron runs / hour vs the current 4)
- Or extend the webhook to call `runGhlSync` inline when an unknown
  contact arrives (gives realtime new-contact onboarding, costs a
  ~10s webhook response)

Both are 1-line changes — say the word.

---

## How to verify it's working

After the workflow is published, change one of these in GHL and refresh
the Wooster Portal Forms Tracker (no cache-buster needed — the page
fetcher has a 60-second in-memory cache; a hard refresh after a minute
gets fresh data):

1. **Rename a parent** in GHL: First name "Rachel" → "Rachel Anne"
   → look at the tracker — Rachel's family row should show the new
   name within 1–2 minutes.
2. **Update a student's last name** via the parent contact's
   `student_last_name` custom field
   → the student row in our DB updates; appears in the Portal Forms
   Tracker's Students column.
3. **Change a parent's email** → reflected in the inbox under the
   "by parent (email)" suffix.

If nothing happens after 2 minutes:
- Open `ghl_webhook_log` — recent rows for school_id Wooster will show
  whether GHL is hitting us at all
- If `status='rejected'` → token mismatch; verify `GHL_WEBHOOK_SECRET`
  matches what's in the GHL workflow header
- If `status='ignored'` and contact_id is set → that contact isn't in
  our parents table (parent never synced or was hard-deleted in our
  DB); run `sync-wooster-from-ghl.mjs` to onboard them
- If no rows at all → GHL isn't sending. Re-check the workflow URL +
  publish status

---

## Operational watchpoints

- **Rate limit**: each webhook fires a GHL API call back to /contacts/.
  GHL's limit is generous (10/sec per location); not a concern for
  Wooster's volume.
- **Loops**: when WE write back to GHL (tuition status, password-set
  timestamp), GHL fires a ContactUpdate webhook. We re-fetch and
  overwrite the same data — no-op cascade. No infinite loop because
  the values match.
- **Multiple workflows**: if you publish multiple workflows that all
  trigger the same webhook, every contact change fires N events.
  Dedup catches them via webhook_id, but it's wasteful. One workflow,
  multiple triggers is cleaner.

---

*Lives at `docs/WOOSTER_GHL_SOURCE_OF_TRUTH.md`. Ping if anything in
this file gets out of date.*
