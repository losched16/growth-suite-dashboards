// POST /api/webhooks/ghl/deposit
//
// Enrollment-deposit trigger. A GHL workflow ("Opportunity stage = Offer
// Accepted" → Custom Webhook) calls this. We ensure the family exists (so it
// has a portal + a billing record) and then invoice the enrollment deposit —
// a full deposit for the first child, the reduced sibling deposit for each
// additional. The 15-minute cron runs the same logic as a safety net.
//
// Auth mirrors the enroll webhook: a static shared token as `?key=` or an
// `x-enroll-key` header (GHL_ENROLL_TOKEN, falling back to GHL_WEBHOOK_SECRET).
// Always 200 (except bad token) so a workflow can't retry-storm.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { query } from '@/lib/db';
import { createFamilyFromContact } from '@/lib/sync/create-family-from-contact';
import { readDepositConfig, generateEnrollmentDeposits } from '@/lib/billing/enrollment-deposits';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 25;

function tokenOk(provided: string | null): boolean {
  const expected = process.env.GHL_ENROLL_TOKEN || process.env.GHL_WEBHOOK_SECRET;
  if (!expected || !provided) return false;
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

  // Only live, import-managed (attributes_only) schools — same guard as enroll.
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

  // Feature gate: nothing happens (not even provisioning) unless this school
  // has turned enrollment deposits on.
  const cfg = await readDepositConfig(school.id);
  if (!cfg) return NextResponse.json({ ok: true, skipped: 'enrollment_deposit not enabled' });

  try {
    // Ensure the family exists (idempotent) so we have someone to invoice + a
    // portal for them to pay in.
    const create = await createFamilyFromContact(school.id, contactId);
    let familyId = create.family_id;
    if (!familyId) {
      const { rows: pr } = await query<{ family_id: string }>(
        `SELECT family_id FROM parents WHERE school_id = $1 AND ghl_contact_id = $2 LIMIT 1`,
        [school.id, contactId],
      );
      familyId = pr[0]?.family_id;
    }
    if (!familyId) {
      return NextResponse.json({ ok: true, skipped: `no family: ${create.reason ?? 'unresolved'}` });
    }

    const dep = await generateEnrollmentDeposits(school.id, familyId);
    return NextResponse.json({ ok: true, family_id: familyId, created: dep.created, skipped: dep.skipped });
  } catch (e) {
    console.error('[webhooks/ghl/deposit] failed:', e instanceof Error ? e.message : String(e));
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
