// POST /api/webhooks/ghl/enroll
//
// Instant enrollment trigger. A GHL workflow ("Opportunity stage =
// Enrolled" → Custom Webhook) calls this, and we immediately create the
// loginable family-graph record for the contact — instead of waiting for
// the 15-minute cron (which still runs as a safety net / catch-up).
//
// Auth: a static shared token (GHL workflows can't HMAC the body). The
// workflow includes it as `?key=<token>` or an `x-enroll-key` header. We
// accept GHL_ENROLL_TOKEN, falling back to the existing GHL_WEBHOOK_SECRET
// so no new env var is strictly required. Fails closed if neither is set.
//
// Always returns 200 (except bad token → 401) so GHL doesn't retry-storm:
// any miss is caught by the cron within 15 minutes anyway.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { query } from '@/lib/db';
import { createFamilyFromContact } from '@/lib/sync/create-family-from-contact';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 25;

function tokenOk(provided: string | null): boolean {
  const expected = process.env.GHL_ENROLL_TOKEN || process.env.GHL_WEBHOOK_SECRET;
  if (!expected || !provided) return false; // fail closed
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function asString(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  return null;
}

// GHL workflow custom-webhook payloads vary; pull contact + location id
// from any of the common shapes.
function extract(body: unknown): { contactId: string | null; locationId: string | null } {
  const root = (body && typeof body === 'object') ? body as Record<string, unknown> : {};
  const contact = (root.contact && typeof root.contact === 'object') ? root.contact as Record<string, unknown> : root;
  const loc = (root.location && typeof root.location === 'object') ? root.location as Record<string, unknown> : {};
  const contactId = asString(root.contactId) ?? asString(root.contact_id)
    ?? asString(contact.id) ?? asString(contact.contactId) ?? asString(contact.contact_id);
  const locationId = asString(root.locationId) ?? asString(root.location_id)
    ?? asString(loc.id) ?? asString(contact.locationId) ?? asString(contact.location_id);
  return { contactId, locationId };
}

export async function POST(request: NextRequest) {
  const url = new URL(request.url);
  const provided = request.headers.get('x-enroll-key') ?? url.searchParams.get('key');
  if (!tokenOk(provided)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: unknown = {};
  try { body = await request.json(); } catch { /* tolerate non-JSON / empty */ }
  const { contactId, locationId } = extract(body);
  if (!contactId || !locationId) {
    return NextResponse.json({ ok: true, skipped: 'missing contact_id or location_id' });
  }

  // Resolve the school + guard rails: only live, import-managed schools.
  // Snapshot schools create families on their full sync, so an instant
  // create there could collide with the destructive rebuild — skip them.
  const { rows } = await query<{ id: string; sync_mode: string | null; active: boolean }>(
    `SELECT s.id, s.sync_mode, COALESCE(spc.billing_active, false) AS active
       FROM schools s
       LEFT JOIN school_payment_config spc ON spc.school_id = s.id
      WHERE s.ghl_location_id = $1 LIMIT 1`,
    [locationId],
  );
  const school = rows[0];
  if (!school) return NextResponse.json({ ok: true, skipped: 'unknown location' });
  if ((school.sync_mode ?? 'snapshot') !== 'attributes_only' || !school.active) {
    return NextResponse.json({ ok: true, skipped: `sync_mode=${school.sync_mode} billing_active=${school.active}` });
  }

  try {
    const result = await createFamilyFromContact(school.id, contactId);
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    console.error('[webhooks/ghl/enroll] failed:', e instanceof Error ? e.message : String(e));
    // 200 (not 5xx) — the cron will retry within 15 min; no retry storm.
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
