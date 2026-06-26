// POST /api/webhooks/ghl/portal-welcome
//
// Provisioning trigger. A GHL workflow ("Opportunity stage = Pending
// Opportunities" → Custom Webhook) calls this when a family is ready to
// enroll. We look up the contact's primary parent and email them a
// branded welcome that sends them to the parent portal to CREATE A
// PASSWORD (using the email already on file) and sign their enrollment
// agreement (which prefills from their contact record).
//
// Unlike /enroll this is NOT gated to attributes_only/billing schools —
// it just sends an email, so it's safe for any sync mode (DGM 2.0 is
// snapshot). It does not create or mutate roster data.
//
// Auth: static shared token (GHL workflows can't HMAC the body). The
// workflow sends it as `x-webhook-token` / `x-enroll-key` / `Authorization:
// Bearer` header or `?key=`. Accepts GHL_ENROLL_TOKEN, falling back to
// GHL_WEBHOOK_SECRET so the secret already configured for the contact
// webhook works. Fails closed if neither is set.
//
// Always returns 200 (except bad token → 401) so GHL doesn't retry-storm.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { query } from '@/lib/db';
import { sendBrandedEmail } from '@/lib/email';

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

function portalBase(): string {
  return (process.env.PARENT_PORTAL_BASE_URL || 'https://growth-suite-parent-portal.vercel.app').replace(/\/$/, '');
}

function welcomeEmail(opts: {
  schoolName: string; firstName: string | null; loginUrl: string; supportEmail: string | null;
}): { subject: string; html: string; text: string } {
  const hi = opts.firstName ? `Hi ${opts.firstName},` : 'Hello,';
  const subject = `Welcome to your ${opts.schoolName} parent portal`;
  const support = opts.supportEmail
    ? `<p style="font-size:12px;color:#6b7280;margin-top:24px">Questions? Email <a href="mailto:${opts.supportEmail}">${opts.supportEmail}</a>.</p>`
    : '';
  const supportText = opts.supportEmail ? `\n\nQuestions? Email ${opts.supportEmail}.` : '';
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;color:#111827">
  <h2 style="color:#047857;margin-bottom:4px">Welcome to ${opts.schoolName}</h2>
  <p>${hi}</p>
  <p>Your family is ready to complete enrollment. To get started, create a password for your parent portal using the email address this message was sent to.</p>
  <p>Once you're in, you'll review and sign your <strong>enrollment agreement</strong> — it's already pre-filled with your family's information.</p>
  <p style="margin:28px 0">
    <a href="${opts.loginUrl}" style="background:#047857;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">Create your password &amp; sign in</a>
  </p>
  <p style="font-size:12px;color:#6b7280">If the button doesn't work, paste this link into your browser:<br>${opts.loginUrl}</p>
  ${support}
</div>`;
  const text = `Welcome to ${opts.schoolName}

${hi}

Your family is ready to complete enrollment. Create a password for your parent portal using the email address this message was sent to, then review and sign your pre-filled enrollment agreement.

Create your password & sign in:
${opts.loginUrl}${supportText}`;
  return { subject, html, text };
}

export async function POST(request: NextRequest) {
  const url = new URL(request.url);
  const authHeader = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const provided = request.headers.get('x-webhook-token')
    ?? request.headers.get('x-enroll-key')
    ?? (authHeader || null)
    ?? url.searchParams.get('key');
  if (!tokenOk(provided)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: unknown = {};
  try { body = await request.json(); } catch { /* tolerate non-JSON / empty */ }
  const { contactId, locationId } = extract(body);
  if (!contactId) {
    return NextResponse.json({ ok: true, skipped: 'missing contact_id' });
  }

  // Resolve school (by locationId, else by the contact's parent row).
  let schoolId: string | null = null;
  let schoolName = 'your school';
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
  if (!schoolId) {
    const { rows } = await query<{ school_id: string }>(
      `SELECT school_id FROM parents WHERE ghl_contact_id = $1 LIMIT 1`, [contactId],
    );
    if (rows[0]) {
      schoolId = rows[0].school_id;
      const s = await query<{ name: string; support_email: string | null; display_name: string | null }>(
        `SELECT s.name, b.support_email, b.display_name FROM schools s
           LEFT JOIN school_branding b ON b.school_id = s.id WHERE s.id = $1`, [schoolId]);
      if (s.rows[0]) { schoolName = s.rows[0].display_name || s.rows[0].name; supportEmail = s.rows[0].support_email; }
    }
  }
  if (!schoolId) return NextResponse.json({ ok: true, skipped: 'unknown location/contact' });

  // The contact's parent row (prefer the primary).
  const { rows: prows } = await query<{ id: string; email: string | null; first_name: string | null; password_set_at: string | null }>(
    `SELECT id, email, first_name, password_set_at
       FROM parents
      WHERE school_id = $1 AND ghl_contact_id = $2 AND status = 'active'
      ORDER BY is_primary DESC, created_at ASC LIMIT 1`,
    [schoolId, contactId],
  );
  const parent = prows[0];
  if (!parent || !parent.email) {
    return NextResponse.json({ ok: true, skipped: 'no active parent with email' });
  }
  // Already onboarded — they have a password; nothing to send.
  if (parent.password_set_at) {
    return NextResponse.json({ ok: true, skipped: 'already onboarded' });
  }
  // Dedup: don't re-send within 6h if the stage re-fires.
  const { rows: dup } = await query<{ id: string }>(
    `SELECT id FROM ghl_webhook_log
      WHERE ghl_contact_id = $1 AND event_type = 'portal_welcome' AND status = 'applied'
        AND received_at > now() - interval '6 hours' LIMIT 1`,
    [contactId],
  );
  if (dup.length) return NextResponse.json({ ok: true, deduped: true });

  const loginUrl = `${portalBase()}/login?email=${encodeURIComponent(parent.email)}`;
  const msg = welcomeEmail({ schoolName, firstName: parent.first_name, loginUrl, supportEmail });

  let status: 'applied' | 'failed' = 'applied';
  let err: string | null = null;
  try {
    await sendBrandedEmail({
      to: parent.email, schoolId, subject: msg.subject, html: msg.html, text: msg.text,
      replyToOverride: supportEmail ?? undefined,
    });
  } catch (e) {
    status = 'failed';
    err = e instanceof Error ? e.message : String(e);
    console.error('[webhooks/ghl/portal-welcome] send failed:', err);
  }

  await query(
    `INSERT INTO ghl_webhook_log
        (school_id, event_type, ghl_location_id, ghl_contact_id, payload, status, rows_affected, error_message, webhook_id)
     VALUES ($1, 'portal_welcome', $2, $3, $4::jsonb, $5, $6, $7, NULL)`,
    [schoolId, locationId, contactId, JSON.stringify({ to: parent.email }), status, status === 'applied' ? 1 : 0, err],
  ).catch(() => undefined);

  return NextResponse.json({ ok: status === 'applied', sent: status === 'applied', to: parent.email });
}

// GET — self-diagnostic. Reports whether the secret is set + recent
// portal-welcome activity, without leaking the secret or PII.
export async function GET() {
  const secretConfigured = !!(process.env.GHL_ENROLL_TOKEN || process.env.GHL_WEBHOOK_SECRET);
  const { rows } = await query<{ received_at: string; status: string; ghl_location_id: string | null; error_message: string | null }>(
    `SELECT received_at, status, ghl_location_id, error_message
       FROM ghl_webhook_log WHERE event_type = 'portal_welcome'
      ORDER BY received_at DESC LIMIT 10`,
  ).catch(() => ({ rows: [] as never[] }));
  const hint = !secretConfigured
    ? 'No GHL_ENROLL_TOKEN/GHL_WEBHOOK_SECRET set — every request is rejected.'
    : rows.length === 0
      ? 'Secret set, but no welcome has been sent yet. Move a test contact into the stage to fire the workflow.'
      : 'Welcome emails are being sent.';
  return NextResponse.json({ ok: true, secret_configured: secretConfigured, recent: rows, hint });
}
