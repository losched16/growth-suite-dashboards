// POST /api/webhooks/ghl/contact
//
// Inbound webhook from GHL — fires whenever a contact is created or
// updated. We use it to keep the parents (and student last_name)
// columns in sync with HighLevel without waiting for the daily cron.
//
// Compatible with both webhook delivery paths:
//   - GHL Marketplace app webhook (when a Connect app is installed)
//   - GHL Workflow "Custom Webhook" action (per-location automation)
// Both POST a JSON body that describes the contact. We tolerate either.
//
// Auth: HMAC-SHA256 over the raw body, hex-encoded, sent in either
// header (depending on which delivery path):
//   x-wh-signature      — Marketplace app convention
//   x-webhook-signature — Workflow webhook convention
// The shared secret comes from env: GHL_WEBHOOK_SECRET. To roll
// secrets, support both old + new: GHL_WEBHOOK_SECRET_PREVIOUS.
//
// On success: we 200 with a tiny JSON body. GHL retries any non-2xx,
// so we MUST 200 even for "nothing to do" cases (unknown location,
// unknown contact id, duplicate event) — otherwise GHL retries forever.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { query, withTransaction } from '@/lib/db';
import { loadGhlClient } from '@/lib/ghl/client';
import { getContact } from '@/lib/ghl/contacts';
import { loadFieldKeyMap } from '@/lib/ghl/custom-fields-cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

// ─── Signature verification ──────────────────────────────────────────

function timingSafeEqualHex(a: string, b: string): boolean {
  // Pad shorter to longer to avoid throwing in timingSafeEqual.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function sigOf(secret: string, rawBody: string): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function verifySignature(rawBody: string, providedSig: string): boolean {
  // Active + previous secret support so the operator can rotate without
  // a coordinated GHL-side change. Set GHL_WEBHOOK_SECRET to the new
  // value and leave GHL_WEBHOOK_SECRET_PREVIOUS as the old value for a
  // grace window, then unset PREVIOUS.
  const active = process.env.GHL_WEBHOOK_SECRET;
  const previous = process.env.GHL_WEBHOOK_SECRET_PREVIOUS;
  if (!active && !previous) {
    // No secret configured at all. We do NOT accept unsigned requests
    // — fail closed. The operator must set GHL_WEBHOOK_SECRET first.
    return false;
  }
  // Strip an optional "sha256=" prefix (used by some webhook senders).
  const clean = providedSig.replace(/^sha256=/i, '').trim().toLowerCase();
  if (active && timingSafeEqualHex(clean, sigOf(active, rawBody))) return true;
  if (previous && timingSafeEqualHex(clean, sigOf(previous, rawBody))) return true;
  return false;
}

// ─── Payload extraction ──────────────────────────────────────────────

// Defensive: GHL has multiple payload shapes across its webhook
// surfaces (Marketplace app vs Workflow "Custom Webhook" action). We
// extract from any of them with a forgiving traversal.

interface NormalizedContact {
  event_type: string;          // "ContactUpdate", "ContactCreate", etc.
  webhook_id: string | null;   // GHL event id, used for dedup
  location_id: string | null;
  contact_id: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
}

function asString(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  return null;
}

function normalize(body: unknown): NormalizedContact {
  const root = (body && typeof body === 'object') ? body as Record<string, unknown> : {};
  // Marketplace app: top-level `type`, `locationId`, `contactId`, plus
  // a `contact` object. Workflow webhook: top-level fields are the
  // contact itself (firstName, lastName, ...) plus locationId.
  const contact = (root.contact && typeof root.contact === 'object')
    ? root.contact as Record<string, unknown>
    : root;

  const event_type = asString(root.type) ?? asString(root.event)
                  ?? asString(root.eventType) ?? 'ContactUpdate';

  return {
    event_type,
    webhook_id: asString(root.webhookId) ?? asString(root.webhook_id) ?? asString(root.id),
    location_id: asString(root.locationId) ?? asString(root.location_id)
              ?? asString(contact.locationId) ?? asString(contact.location_id),
    contact_id: asString(root.contactId) ?? asString(root.contact_id)
             ?? asString(contact.id) ?? asString(contact.contactId)
             ?? asString(contact.contact_id),
    first_name: asString(contact.firstName) ?? asString(contact.first_name),
    last_name: asString(contact.lastName) ?? asString(contact.last_name),
    email: asString(contact.email),
    phone: asString(contact.phone),
  };
}

// ─── Apply ───────────────────────────────────────────────────────────

interface ApplyResult { rowsAffected: number; status: 'applied' | 'ignored' }

async function applyToParent(
  schoolId: string,
  contact: NormalizedContact,
): Promise<ApplyResult> {
  if (!contact.contact_id) return { rowsAffected: 0, status: 'ignored' };

  return withTransaction(async (q) => {
    // Capture the old last name BEFORE we update — we need it to
    // identify which students should inherit the new surname (only
    // those who currently share the parent's old surname).
    const { rows: existing } = await q<{ family_id: string; last_name: string | null }>(
      `SELECT family_id, last_name FROM parents
        WHERE school_id = $1 AND ghl_contact_id = $2 LIMIT 1`,
      [schoolId, contact.contact_id],
    );
    if (existing.length === 0) return { rowsAffected: 0, status: 'ignored' };
    const { family_id: familyId, last_name: oldLastName } = existing[0];

    // Update the parent. COALESCE so absent fields don't NULL out
    // existing values (some workflow payloads send only the changed
    // field rather than the full contact).
    const { rowCount: pCount } = await q(
      `UPDATE parents
          SET first_name = COALESCE($3, first_name),
              last_name  = COALESCE($4, last_name),
              email      = COALESCE($5, email),
              phone      = COALESCE($6, phone),
              updated_at = now()
        WHERE school_id = $1 AND ghl_contact_id = $2`,
      [schoolId, contact.contact_id, contact.first_name, contact.last_name, contact.email, contact.phone],
    );
    let rowsAffected = pCount ?? 0;

    // Cascade last-name change to students who currently share the
    // parent's OLD last name — catches the "skulski → Skulski" case
    // without touching students who already have a different surname
    // (blended families, etc).
    if (contact.last_name
        && oldLastName
        && contact.last_name !== oldLastName) {
      const { rowCount: sCount } = await q(
        `UPDATE students
            SET last_name = $3, updated_at = now()
          WHERE school_id = $1 AND family_id = $2 AND last_name = $4`,
        [schoolId, familyId, contact.last_name, oldLastName],
      );
      rowsAffected += sCount ?? 0;
    }

    return { rowsAffected, status: 'applied' };
  });
}

// Full-sync flow: on a webhook event we don't trust the payload's
// fields alone — the workflow Custom Webhook can be configured to send
// only a subset, and Marketplace events can also drop fields. Instead
// we ask GHL for the full contact record and overwrite all our fields
// from the source of truth. Makes "GHL is canonical" actually true.
async function applyFullSync(
  schoolId: string,
  contactId: string,
): Promise<ApplyResult> {
  return withTransaction(async (q) => {
    const { rows: existing } = await q<{ id: string; family_id: string; last_name: string | null }>(
      `SELECT id, family_id, last_name FROM parents
        WHERE school_id = $1 AND ghl_contact_id = $2 LIMIT 1`,
      [schoolId, contactId],
    );
    if (existing.length === 0) return { rowsAffected: 0, status: 'ignored' };
    const { id: parentId, family_id: familyId, last_name: oldLastName } = existing[0];

    // Fetch the canonical record from GHL. If the call fails (rate
    // limit, transient 5xx, deleted contact), fall back to "no-op" so
    // the webhook still 200s — better to miss this update than to
    // null-out fields with bad data.
    const client = await loadGhlClient(schoolId).catch(() => null);
    if (!client) return { rowsAffected: 0, status: 'ignored' };
    const ghlContact = await getContact(client, contactId);
    if (!ghlContact) return { rowsAffected: 0, status: 'ignored' };

    // Index custom field values by field id for lookup.
    const cfById = new Map<string, unknown>();
    for (const cf of ghlContact.customFields ?? []) {
      if (cf.id) cfById.set(cf.id, cf.value);
    }

    // Resolve the school's GHL custom-field catalog so we can map
    // student_first_name / parent_2_first_name etc. by NAME instead
    // of by opaque id. We pull this from GHL directly (cached) — an
    // older version of this code read from `ghl_attributes_catalog`,
    // which was never created in prod and meant the entire per-field
    // cascade silently no-op'd.
    const idByKey = await loadFieldKeyMap(client).catch(() => new Map<string, string>());
    const cfByKey = (key: string): string | null => {
      const id = idByKey.get(key);
      if (!id) return null;
      const v = cfById.get(id);
      if (v == null) return null;
      const s = String(v).trim();
      return s ? s : null;
    };

    // 1. Update the parent — basic fields from the top-level GHL record.
    const firstName = ghlContact.firstName?.trim() || null;
    const lastName  = ghlContact.lastName?.trim() || null;
    const email     = ghlContact.email ?? null;
    const phone     = ghlContact.phone ?? null;

    let rowsAffected = 0;
    const { rowCount: pCount } = await q(
      `UPDATE parents
          SET first_name = COALESCE($3, first_name),
              last_name  = COALESCE($4, last_name),
              email      = COALESCE($5, email),
              phone      = COALESCE($6, phone),
              updated_at = now()
        WHERE id = $7 AND school_id = $1 AND ghl_contact_id = $2`,
      [schoolId, contactId, firstName, lastName, email, phone, parentId],
    );
    rowsAffected += pCount ?? 0;

    // 2. Cascade last-name change to students that share the parent's
    // OLD last name (handles blended families correctly — students with
    // a different surname are left alone).
    if (lastName && oldLastName && lastName !== oldLastName) {
      const { rowCount: sCount } = await q(
        `UPDATE students
            SET last_name = $3, updated_at = now()
          WHERE school_id = $1 AND family_id = $2 AND last_name = $4`,
        [schoolId, familyId, lastName, oldLastName],
      );
      rowsAffected += sCount ?? 0;
    }

    // 3. Sync per-student custom fields. Wooster (and others) store
    // student details as numbered slot fields on the parent contact:
    //   student_first_name, student_last_name, student_date_of_birth,
    //   student_2_first_name, student_2_last_name, ...
    // We update the matching student rows in slot order. If the family
    // has fewer kids than the GHL contact has student slots, the extra
    // slots are ignored — onboarding/sync flow handles new students.
    const { rows: kids } = await q<{ id: string; first_name: string; last_name: string }>(
      `SELECT id, first_name, last_name FROM students
        WHERE school_id = $1 AND family_id = $2 AND status = 'active'
        ORDER BY first_name`,
      [schoolId, familyId],
    );
    const slots = [
      { suffix: '',   index: 0 },
      { suffix: '_2', index: 1 },
      { suffix: '_3', index: 2 },
      { suffix: '_4', index: 3 },
      { suffix: '_5', index: 4 },
      { suffix: '_6', index: 5 },
    ];
    for (const slot of slots) {
      const kid = kids[slot.index];
      if (!kid) continue;
      const sFirst = cfByKey(`student${slot.suffix}_first_name`);
      const sLast  = cfByKey(`student${slot.suffix}_last_name`);
      if (!sFirst && !sLast) continue;
      const { rowCount: stCount } = await q(
        `UPDATE students
            SET first_name = COALESCE($3, first_name),
                last_name  = COALESCE($4, last_name),
                updated_at = now()
          WHERE id = $1 AND school_id = $2`,
        [kid.id, schoolId, sFirst, sLast],
      );
      rowsAffected += stCount ?? 0;
    }

    // 3b. Sync parent 2 from custom-field slots on the primary contact.
    // Wooster's convention is parent_2_first_name / parent_2_last_name /
    // parent_2_cell_phone live as custom fields on the primary parent's
    // contact, not as their own GHL contact. The matching local row is
    // the family's oldest non-primary parent with ghl_contact_id IS NULL
    // (the slot our backfill + parent-portal "add another parent" form
    // both populate). If parent_2_* is populated in GHL but no local row
    // exists yet, auto-create it.
    const p2First = cfByKey('parent_2_first_name');
    const p2Last  = cfByKey('parent_2_last_name');
    const p2Phone = cfByKey('parent_2_cell_phone') ?? cfByKey('parent_2_phone');

    if (p2First || p2Last || p2Phone) {
      const { rows: secondaryRows } = await q<{ id: string }>(
        `SELECT id FROM parents
          WHERE school_id = $1 AND family_id = $2
            AND is_primary = false AND status = 'active'
            AND ghl_contact_id IS NULL
          ORDER BY created_at
          LIMIT 1`,
        [schoolId, familyId],
      );

      if (secondaryRows.length > 0) {
        const { rowCount: p2Count } = await q(
          `UPDATE parents
              SET first_name = COALESCE($3, first_name),
                  last_name  = COALESCE($4, last_name),
                  phone      = COALESCE($5, phone),
                  updated_at = now()
            WHERE id = $1 AND school_id = $2`,
          [secondaryRows[0].id, schoolId, p2First, p2Last, p2Phone],
        );
        rowsAffected += p2Count ?? 0;
      } else if (p2First && p2Last) {
        // Auto-create — only when we have both names. Skips noise from
        // half-filled GHL records (e.g. only parent_2_cell_phone set).
        const { rowCount: p2Ins } = await q(
          `INSERT INTO parents
             (family_id, school_id, ghl_contact_id, first_name, last_name,
              email, phone, role, is_primary, status)
           VALUES ($1, $2, NULL, $3, $4, NULL, $5, 'parent', false, 'active')`,
          [familyId, schoolId, p2First, p2Last, p2Phone],
        );
        rowsAffected += p2Ins ?? 0;
      }
    }

    // 4. Family display name follows the primary parent's full name
    //    "FirstName LastName" when the school doesn't set a custom one.
    //    Only touch when both names are present so we don't blank it.
    if (firstName && lastName) {
      const { rowCount: fCount } = await q(
        `UPDATE families
            SET display_name = $1, updated_at = now()
          WHERE id = $2 AND school_id = $3`,
        [`${firstName} ${lastName}`, familyId, schoolId],
      );
      rowsAffected += fCount ?? 0;
    }

    return { rowsAffected, status: 'applied' };
  });
}

async function resolveSchoolId(locationId: string | null): Promise<string | null> {
  if (!locationId) return null;
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM schools WHERE ghl_location_id = $1 LIMIT 1`,
    [locationId],
  );
  return rows[0]?.id ?? null;
}

// ─── Handler ─────────────────────────────────────────────────────────

// Static-token auth for GHL Workflow webhooks. Workflow "Custom
// Webhook" actions can attach a static header but CANNOT compute an
// HMAC over the body — so the HMAC-only design made the workflow
// delivery path impossible to configure. A static bearer token in
// x-webhook-token (constant-time compared against the same
// GHL_WEBHOOK_SECRET) closes that gap. HMAC paths still work and
// remain preferred for senders that can sign.
function verifyStaticToken(provided: string): boolean {
  const candidates = [process.env.GHL_WEBHOOK_SECRET, process.env.GHL_WEBHOOK_SECRET_PREVIOUS]
    .filter((s): s is string => !!s && s.length > 0);
  if (!provided) return false;
  for (const expected of candidates) {
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const sig = request.headers.get('x-wh-signature')
           ?? request.headers.get('x-webhook-signature')
           ?? request.headers.get('x-ghl-signature')
           ?? '';
  // Static token can arrive under several header names depending on how
  // the operator named the header in the GHL workflow's Custom Webhook
  // config. Accept the common ones + strip an optional "Bearer " prefix
  // so a value pasted as "Bearer <secret>" still matches.
  const staticToken = (
    request.headers.get('x-webhook-token')
    ?? request.headers.get('x-api-key')
    ?? request.headers.get('token')
    ?? request.headers.get('authorization')
    ?? ''
  ).replace(/^Bearer\s+/i, '').trim();

  if (!verifySignature(rawBody, sig) && !verifyStaticToken(staticToken)) {
    // Log the rejected attempt so launch-day debugging can SEE whether
    // GHL is reaching us at all + which headers it sent. We store header
    // NAMES only (never values — they could contain the real token) and
    // a short body preview. webhook_id is left NULL so a later retry
    // with valid auth isn't blocked by the dedup unique index. Best-
    // effort; never blocks the 401.
    await logRejected(request, rawBody).catch(() => undefined);
    return NextResponse.json({ error: 'invalid_signature' }, { status: 401 });
  }

  let body: unknown;
  try { body = JSON.parse(rawBody); }
  catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const contact = normalize(body);

  // Dedup: if we've already processed this webhook_id, return 200 + skip.
  if (contact.webhook_id) {
    const { rows: dup } = await query<{ id: string; status: string }>(
      `SELECT id, status FROM ghl_webhook_log WHERE webhook_id = $1 LIMIT 1`,
      [contact.webhook_id],
    );
    if (dup.length > 0) {
      return NextResponse.json({ ok: true, deduped: true, status: dup[0].status });
    }
  }

  const schoolId = await resolveSchoolId(contact.location_id);

  // Persist the event regardless of whether we apply it — gives us
  // forensics for "why didn't X change land?" cases.
  let status: 'applied' | 'ignored' | 'failed' = 'ignored';
  let rowsAffected = 0;
  let errorMessage: string | null = null;

  if (schoolId && contact.contact_id
      && (contact.event_type === 'ContactUpdate' || contact.event_type === 'ContactCreate'
          || contact.event_type.toLowerCase().includes('contact'))) {
    try {
      // Full-sync path: fetch the canonical contact from GHL and
      // overwrite all our fields (basic + per-student custom-field
      // slots + family display name). This is what makes GHL the
      // source of truth — workflow payload field set doesn't matter.
      const r = await applyFullSync(schoolId, contact.contact_id);
      status = r.status;
      rowsAffected = r.rowsAffected;
      // Fallback to the payload-only apply if the full-sync was a
      // no-op (e.g. GHL API down) AND the payload has real field
      // values. Better to capture some change than miss it entirely.
      if (status === 'ignored' && (contact.first_name || contact.last_name || contact.email || contact.phone)) {
        const fallback = await applyToParent(schoolId, contact);
        if (fallback.status === 'applied') {
          status = fallback.status;
          rowsAffected = fallback.rowsAffected;
        }
      }
    } catch (err) {
      status = 'failed';
      errorMessage = err instanceof Error ? err.message : String(err);
    }
  }

  await query(
    `INSERT INTO ghl_webhook_log
        (school_id, event_type, ghl_location_id, ghl_contact_id, payload,
         status, rows_affected, error_message, webhook_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)`,
    [
      schoolId, contact.event_type, contact.location_id, contact.contact_id,
      JSON.stringify(body ?? null),
      status, rowsAffected, errorMessage, contact.webhook_id,
    ],
  ).catch((e) => {
    // Best-effort log — don't make the webhook itself fail because the
    // log table couldn't write. Surface to console for ops to notice.
    console.error('[ghl-webhook] log insert failed:', e);
  });

  // Return 200 even on ignored — GHL retries on non-2xx and we don't
  // want a forever-retry loop just because a contact id isn't ours.
  return NextResponse.json({ ok: true, status, rowsAffected });
}

// Log a rejected (failed-auth) attempt so we can confirm whether GHL is
// reaching the endpoint during setup. Stores header NAMES + a short
// body preview — never header values (which carry the token), never the
// webhook_id (so a fixed-auth retry isn't deduped away).
async function logRejected(request: NextRequest, rawBody: string): Promise<void> {
  const headerNames = [...request.headers.keys()].sort().join(', ');
  let parsed: unknown = null;
  try { parsed = JSON.parse(rawBody); } catch { /* non-JSON body — keep null */ }
  const norm = parsed ? normalize(parsed) : null;
  const schoolId = norm ? await resolveSchoolId(norm.location_id) : null;
  await query(
    `INSERT INTO ghl_webhook_log
        (school_id, event_type, ghl_location_id, ghl_contact_id, payload,
         status, rows_affected, error_message, webhook_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'rejected', 0, $6, NULL)`,
    [
      schoolId,
      norm?.event_type ?? 'unknown',
      norm?.location_id ?? null,
      norm?.contact_id ?? null,
      JSON.stringify({ header_names: headerNames, body_preview: rawBody.slice(0, 800) }),
      'auth_failed: no valid HMAC signature and no matching static token',
    ],
  );
}

// GET /api/webhooks/ghl/contact — lightweight self-diagnostic. Safe to
// open in a browser: reports whether the shared secret is configured and
// the recent webhook activity (including 'rejected' attempts) WITHOUT
// revealing the secret or any contact PII. This is the fastest way to
// answer "is GHL actually reaching us?" while wiring up a new school.
export async function GET() {
  const secretConfigured = !!process.env.GHL_WEBHOOK_SECRET || !!process.env.GHL_WEBHOOK_SECRET_PREVIOUS;

  const { rows: counts } = await query<{ status: string; n: number }>(
    `SELECT status, count(*)::int AS n FROM ghl_webhook_log
      WHERE received_at > now() - interval '24 hours' GROUP BY status`,
  ).catch(() => ({ rows: [] as { status: string; n: number }[] }));

  const { rows: recent } = await query<{
    received_at: string; status: string; event_type: string;
    ghl_location_id: string | null; rows_affected: number; error_message: string | null;
  }>(
    `SELECT received_at, status, event_type, ghl_location_id, rows_affected, error_message
       FROM ghl_webhook_log ORDER BY received_at DESC LIMIT 10`,
  ).catch(() => ({ rows: [] }));

  const total = recent.length;
  const hint = !secretConfigured
    ? 'GHL_WEBHOOK_SECRET is NOT set in this environment — every request will be rejected. Set it in Vercel and redeploy.'
    : total === 0
      ? 'Secret is configured but no webhook has EVER been received. Either the GHL workflow has not fired yet (edit a test contact to trigger it) or the workflow is not posting to this URL. Edit a contact in GHL, then refresh this page.'
      : recent.every((r) => r.status === 'rejected')
        ? 'GHL IS reaching us, but every request is being REJECTED — the token/signature does not match. Check the header_names in the rejected log rows and confirm the workflow sends the secret in x-webhook-token (or Authorization: Bearer).'
        : 'Webhooks are being received and applied. Integration is live.';

  return NextResponse.json({
    ok: true,
    secret_configured: secretConfigured,
    last_24h: Object.fromEntries(counts.map((c) => [c.status, c.n])),
    recent_events: recent,
    hint,
  });
}
