// POST /api/webhooks/ghl/applicant-invite
//
// "Ready to apply" trigger for admissions schools that run their application
// and document collection in the parent portal (Nativity). A GHL workflow
// (Opportunity stage = the school's ready-to-apply stage → Custom Webhook)
// calls this with the contact id. We:
//   1. make sure the contact has a parent-only portal family (no students — an
//      applicant is not enrolled) and stamp it as invited, which is what lets
//      the parent create a login (portal: lib/auth/portal-provisioning.ts);
//   2. email the family a branded invite: create an account, complete the
//      application, upload the documents;
//   3. tag the contact so staff can see the outcome in a CRM smart list —
//      "portal invite sent" or "portal invite failed" (e.g. no email on file).
//
// Opt-in per school: does nothing unless settings.applicant_invites is true.
// Idempotent — a stage that re-fires inside 6 hours sends nothing twice.
//
// Auth: a static shared token (GHL workflows can't HMAC the body):
// `x-webhook-token` / `x-enroll-key` / `Authorization: Bearer` / `?key=`.
// APPLICANT_INVITE_TOKEN, falling back to GHL_ENROLL_TOKEN then
// GHL_WEBHOOK_SECRET; fails closed when none is set.
//
// Always 200 (except a bad token → 401) so GHL doesn't retry-storm.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { query } from '@/lib/db';
import { sendBrandedEmail } from '@/lib/email';
import { loadGhlClient } from '@/lib/ghl/client';
import { loadSchoolSettings } from '@/lib/school-settings';
import { createApplicantFamily } from '@/lib/sync/create-applicant-family';
import { parentPortalBaseForSchool } from '@/lib/parent-portal-base';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const EVENT = 'applicant_invite';
const TAG_SENT = 'portal invite sent';
const TAG_FAILED = 'portal invite failed';

function tokenOk(provided: string | null): boolean {
  // Its own token first, so this webhook can be rotated or revoked without
  // touching the contact / enroll / welcome workflows that share the older ones.
  const expected = process.env.APPLICANT_INVITE_TOKEN || process.env.GHL_ENROLL_TOKEN || process.env.GHL_WEBHOOK_SECRET;
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

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inviteEmail(opts: {
  schoolName: string; firstName: string | null; loginUrl: string; supportEmail: string | null;
  returning: boolean; steps: string[];
}): { subject: string; html: string; text: string } {
  const hi = opts.firstName ? `Hi ${esc(opts.firstName)},` : 'Hello,';
  const hiText = opts.firstName ? `Hi ${opts.firstName},` : 'Hello,';
  const subject = `Start your application to ${opts.schoolName}`;
  const lead = opts.returning
    ? `You already have a parent portal account. Sign in with the email address this message was sent to to complete your application.`
    : `Create your parent portal account using the email address this message was sent to — then you can complete the application and upload the supporting documents, all in one place.`;
  const cta = opts.returning ? 'Sign in & start your application' : 'Create your account & start your application';
  const list = opts.steps.length
    ? `<p style="margin:16px 0 4px"><strong>You'll complete:</strong></p><ul style="margin:0 0 8px;padding-left:20px">${opts.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`
    : '';
  const listText = opts.steps.length ? `\n\nYou'll complete:\n${opts.steps.map((s) => `  - ${s}`).join('\n')}` : '';
  const support = opts.supportEmail
    ? `<p style="font-size:12px;color:#6b7280;margin-top:24px">Questions? Email <a href="mailto:${esc(opts.supportEmail)}">${esc(opts.supportEmail)}</a>.</p>`
    : '';
  const supportText = opts.supportEmail ? `\n\nQuestions? Email ${opts.supportEmail}.` : '';
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;color:#111827">
  <h2 style="margin-bottom:4px">You're invited to apply to ${esc(opts.schoolName)}</h2>
  <p>${hi}</p>
  <p>Thank you for your interest in ${esc(opts.schoolName)}. ${esc(lead)}</p>
  ${list}
  <p style="margin:28px 0">
    <a href="${opts.loginUrl}" style="background:#1d4ed8;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">${cta}</a>
  </p>
  <p style="font-size:12px;color:#6b7280">If the button doesn't work, paste this link into your browser:<br>${opts.loginUrl}</p>
  ${support}
</div>`;
  const text = `You're invited to apply to ${opts.schoolName}

${hiText}

Thank you for your interest in ${opts.schoolName}. ${lead}${listText}

${cta}:
${opts.loginUrl}${supportText}`;
  return { subject, html, text };
}

async function tagContact(schoolId: string, contactId: string, tags: string[]): Promise<void> {
  try {
    const client = await loadGhlClient(schoolId);
    await client.axios.post(`/contacts/${contactId}/tags`, { tags });
  } catch (e) {
    console.warn('[applicant-invite] tag write failed:', e instanceof Error ? e.message : String(e));
  }
}

export async function POST(request: NextRequest) {
  const url = new URL(request.url);
  const authHeader = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const provided = request.headers.get('x-webhook-token')
    ?? request.headers.get('x-enroll-key')
    ?? (authHeader || null)
    ?? url.searchParams.get('key');
  if (!tokenOk(provided)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: unknown = {};
  try { body = await request.json(); } catch { /* tolerate non-JSON / empty */ }
  const { contactId, locationId } = extract(body);
  if (!contactId) return NextResponse.json({ ok: true, skipped: 'missing contact_id' });

  // Resolve the school: by location id, else by an existing parent on the contact.
  let schoolId: string | null = null;
  let schoolName = 'our school';
  let supportEmail: string | null = null;
  if (locationId) {
    const { rows } = await query<{ id: string; name: string; support_email: string | null; display_name: string | null }>(
      `SELECT s.id, s.name, b.support_email, b.display_name
         FROM schools s LEFT JOIN school_branding b ON b.school_id = s.id
        WHERE s.ghl_location_id = $1 LIMIT 1`,
      [locationId],
    );
    if (rows[0]) { schoolId = rows[0].id; schoolName = rows[0].display_name || rows[0].name; supportEmail = rows[0].support_email; }
  }
  if (!schoolId) return NextResponse.json({ ok: true, skipped: 'unknown location' });

  const settings = await loadSchoolSettings(schoolId);
  if (!settings.applicant_invites) return NextResponse.json({ ok: true, skipped: 'applicant invites not enabled for this school' });

  const log = (status: 'applied' | 'failed', payload: Record<string, unknown>, err: string | null) =>
    query(
      `INSERT INTO ghl_webhook_log
          (school_id, event_type, ghl_location_id, ghl_contact_id, payload, status, rows_affected, error_message, webhook_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, NULL)`,
      [schoolId, EVENT, locationId, contactId, JSON.stringify(payload), status, status === 'applied' ? 1 : 0, err],
    ).catch(() => undefined);

  // Dedup: a stage that re-fires inside 6h must not send twice.
  const { rows: dup } = await query<{ id: string }>(
    `SELECT id FROM ghl_webhook_log
      WHERE ghl_contact_id = $1 AND event_type = $2 AND status = 'applied'
        AND received_at > now() - interval '6 hours' LIMIT 1`,
    [contactId, EVENT],
  );
  if (dup.length) return NextResponse.json({ ok: true, deduped: true });

  let result;
  try {
    result = await createApplicantFamily(schoolId, contactId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[applicant-invite] create failed:', msg);
    await log('failed', { stage: 'create' }, msg);
    await tagContact(schoolId, contactId, [TAG_FAILED]);
    return NextResponse.json({ ok: false, error: 'create_failed' });
  }
  if (!result.ok || !result.parent_email) {
    await log('failed', { reason: result.reason }, result.reason ?? 'unknown');
    await tagContact(schoolId, contactId, [TAG_FAILED]);
    return NextResponse.json({ ok: false, reason: result.reason });
  }

  // What the family will be asked to do: the school's active parent forms, in
  // the order they were built (application first, then the documents).
  const { rows: forms } = await query<{ display_name: string }>(
    `SELECT display_name FROM portal_form_definitions
      WHERE school_id = $1 AND is_active = true AND COALESCE(audience, 'parents') = 'parents'
        AND COALESCE(list_in_checklist, true) = true
      ORDER BY created_at ASC`,
    [schoolId],
  );

  const loginUrl = `${await parentPortalBaseForSchool(schoolId)}/login?email=${encodeURIComponent(result.parent_email)}`;
  const msg = inviteEmail({
    schoolName, firstName: result.parent_first_name ?? null, loginUrl, supportEmail,
    returning: !!result.has_password, steps: forms.map((f) => f.display_name),
  });

  try {
    await sendBrandedEmail({
      to: result.parent_email, schoolId, subject: msg.subject, html: msg.html, text: msg.text,
      replyToOverride: supportEmail ?? undefined,
    });
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    console.error('[applicant-invite] send failed:', err);
    await log('failed', { to: result.parent_email, family_id: result.family_id }, err);
    await tagContact(schoolId, contactId, [TAG_FAILED]);
    return NextResponse.json({ ok: false, error: 'send_failed' });
  }

  await log('applied', { to: result.parent_email, family_id: result.family_id, created: result.created }, null);
  await tagContact(schoolId, contactId, [TAG_SENT]);
  return NextResponse.json({ ok: true, sent: true, to: result.parent_email, created: result.created });
}

// GET — self-diagnostic, like /portal-welcome: secret configured? recent activity?
export async function GET() {
  const secretConfigured = !!(process.env.APPLICANT_INVITE_TOKEN || process.env.GHL_ENROLL_TOKEN || process.env.GHL_WEBHOOK_SECRET);
  const { rows } = await query<{ received_at: string; status: string; ghl_location_id: string | null; error_message: string | null }>(
    `SELECT received_at, status, ghl_location_id, error_message
       FROM ghl_webhook_log WHERE event_type = $1 ORDER BY received_at DESC LIMIT 10`,
    [EVENT],
  ).catch(() => ({ rows: [] as never[] }));
  return NextResponse.json({
    ok: true,
    secret_configured: secretConfigured,
    recent: rows,
    hint: !secretConfigured
      ? 'No GHL_ENROLL_TOKEN/GHL_WEBHOOK_SECRET set — every request is rejected.'
      : rows.length === 0 ? 'Secret set, no invites sent yet.' : 'Applicant invites are being processed.',
  });
}
