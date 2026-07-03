// POST /api/admin/schools/{schoolId}/enrollments/start
//
// Creates an enrollment_invites row + optionally emails the parent the
// magic link. Returns 303 back to the start page so the operator sees
// the result inline.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { query } from '@/lib/db';
import { sendBrandedEmail } from '@/lib/email';
import { authorizeOperatorOrSchool } from '@/lib/auth/dual';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type Params = Promise<{ schoolId: string }>;

const PARENT_PORTAL_BASE = process.env.PARENT_PORTAL_BASE_URL
  ?? 'https://growth-suite-parent-portal.vercel.app';

// Where to redirect after the POST. Defaults to /admin/{schoolId}/...
// but accepts a `returnTo` override from the caller so the school-scoped
// page (/school/{locationId}/enrollments/start) can keep the operator
// inside the GHL iframe.
//
// returnTo MUST start with `/admin/` or `/school/` and contain no
// scheme/host — otherwise we drop it and fall back to the default. This
// prevents an open-redirect using the form to bounce users off-host.
function safeReturnPath(returnTo: string | null, schoolId: string): string {
  if (returnTo && /^\/(admin|school)\/[A-Za-z0-9_-]+\/(enrollments\/start|forms\/[A-Za-z0-9-]+\/send)$/.test(returnTo)) {
    return returnTo;
  }
  return `/admin/${schoolId}/enrollments/start`;
}

function back(
  request: NextRequest,
  schoolId: string,
  q: { msg?: string; err?: string; invite_id?: string },
  returnTo: string | null = null,
) {
  const url = request.nextUrl.clone();
  url.pathname = safeReturnPath(returnTo, schoolId);
  url.search = '';
  if (q.msg) url.searchParams.set('msg', q.msg);
  if (q.err) url.searchParams.set('err', q.err);
  if (q.invite_id) url.searchParams.set('invite_id', q.invite_id);
  return NextResponse.redirect(url, 303);
}

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId } = await params;
  // Operator OR the school itself (school session) — this endpoint sends
  // parent-facing email, so it must never be anonymous.
  const auth = await authorizeOperatorOrSchool(schoolId);
  if (!auth.ok) return auth.response;
  const fd = await request.formData();

  // Where to bounce the operator on success/failure. The school-scoped
  // page (/school/{locationId}/enrollments/start) sets this to its own
  // path so the operator stays inside the GHL iframe. The /admin/ page
  // omits it, falling through to /admin/{schoolId}/enrollments/start.
  const returnTo = String(fd.get('return_to') ?? '').trim() || null;

  const formDefId = String(fd.get('form_definition_id') ?? '').trim();
  const familyId = String(fd.get('family_id') ?? '').trim();
  const studentIdRaw = String(fd.get('student_id') ?? '').trim();
  const studentId = studentIdRaw || null;
  const internalNote = String(fd.get('internal_note') ?? '').trim() || null;
  const sendEmail = fd.get('send_email') === '1';

  if (!formDefId) return back(request, schoolId, { err: 'Form is required.' }, returnTo);
  if (!familyId)  return back(request, schoolId, { err: 'Family is required.' }, returnTo);

  // Validate the form belongs to this school
  const { rows: defRows } = await query<{ id: string; slug: string; display_name: string }>(
    `SELECT id, slug, display_name FROM portal_form_definitions
      WHERE id = $1 AND school_id = $2 AND is_active = true`,
    [formDefId, schoolId],
  );
  if (defRows.length === 0) {
    return back(request, schoolId, { err: 'Form not found or inactive.' }, returnTo);
  }
  const def = defRows[0];

  // Validate the family belongs to the school
  const { rows: famRows } = await query<{ id: string }>(
    `SELECT id FROM families WHERE id = $1 AND school_id = $2`,
    [familyId, schoolId],
  );
  if (famRows.length === 0) {
    return back(request, schoolId, { err: 'Family not found.' }, returnTo);
  }

  // Build prefill jsonb from any `prefill_*` form fields
  const prefill: Record<string, string> = {};
  for (const [key, value] of fd.entries()) {
    if (typeof key !== 'string') continue;
    if (!key.startsWith('prefill_')) continue;
    const v = String(value).trim();
    if (!v) continue;
    prefill[key.slice('prefill_'.length)] = v;
  }

  // Generate a random URL-safe token. 24 bytes base64url = ~32 chars.
  const token = crypto.randomBytes(24).toString('base64url');

  const operatorEmail = 'operator@growthsuite.local';

  const { rows: insRows } = await query<{ id: string }>(
    `INSERT INTO enrollment_invites
       (school_id, form_definition_id, family_id, student_id,
        token, prefill, internal_note, created_by_email)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
     RETURNING id`,
    [
      schoolId, formDefId, familyId, studentId,
      token, JSON.stringify(prefill), internalNote, operatorEmail,
    ],
  );
  const inviteId = insRows[0].id;

  const inviteUrl = `${PARENT_PORTAL_BASE}/forms-v2/${def.slug}?invite=${encodeURIComponent(token)}`;

  // Optional: send the invite email to all active parents of the family
  let emailSent = 0;
  let emailErr: string | null = null;
  if (sendEmail) {
    try {
      const { rows: parents } = await query<{ email: string; first_name: string | null }>(
        `SELECT email, first_name FROM parents
          WHERE family_id = $1 AND school_id = $2 AND status = 'active' AND email IS NOT NULL`,
        [familyId, schoolId],
      );
      const { rows: schoolRows } = await query<{ name: string }>(
        `SELECT name FROM schools WHERE id = $1`, [schoolId],
      );
      const schoolName = schoolRows[0]?.name ?? 'Your school';

      for (const p of parents) {
        try {
          await sendBrandedEmail({
            to: p.email,
            schoolId,
            subject: `Action needed: ${def.display_name} from ${schoolName}`,
            html: buildInviteHtml({
              firstName: p.first_name,
              schoolName,
              formName: def.display_name,
              inviteUrl,
            }),
            text: buildInviteText({
              firstName: p.first_name,
              schoolName,
              formName: def.display_name,
              inviteUrl,
            }),
          });
          emailSent++;
        } catch (e) {
          emailErr = e instanceof Error ? e.message : String(e);
        }
      }
      if (emailSent > 0) {
        await query(
          `UPDATE enrollment_invites SET sent_at = now() WHERE id = $1`,
          [inviteId],
        );
      }
    } catch (e) {
      emailErr = e instanceof Error ? e.message : String(e);
    }
  }

  const msg = sendEmail
    ? (emailSent > 0
        ? `Invite created and emailed to ${emailSent} parent(s).`
        : (emailErr
            ? `Invite created. Email failed: ${emailErr}. Copy the link below to share manually.`
            : 'Invite created. No active parent emails on file — copy the link below to share manually.'))
    : 'Invite created. Copy the link below to share manually.';

  return back(request, schoolId, { msg, invite_id: inviteId }, returnTo);
}

function buildInviteHtml(opts: { firstName: string | null; schoolName: string; formName: string; inviteUrl: string }): string {
  const greeting = opts.firstName ? `Hi ${escape(opts.firstName)},` : 'Hi,';
  return `
<!doctype html>
<html><body style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #111827; max-width: 520px; margin: 0 auto; padding: 24px;">
  <h2 style="margin: 0 0 8px; font-size: 20px;">Complete your ${escape(opts.formName)}</h2>
  <p style="margin: 0 0 16px; font-size: 14px;">${greeting}</p>
  <p style="margin: 0 0 16px; font-size: 14px;">
    The team at ${escape(opts.schoolName)} has started your enrollment for the 2026-27 school year.
    The student start date and grade level are already filled in — please review the rest of the form,
    pick your tuition + payment plan, sign, and submit.
  </p>
  <p style="margin: 16px 0;">
    <a href="${opts.inviteUrl}" style="display: inline-block; background: #047857; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">
      Open my enrollment →
    </a>
  </p>
  <p style="margin: 16px 0 0; font-size: 12px; color: #6b7280;">
    This link is unique to your family. If you didn&rsquo;t expect this email, you can ignore it.
  </p>
</body></html>`.trim();
}

function buildInviteText(opts: { firstName: string | null; schoolName: string; formName: string; inviteUrl: string }): string {
  const greeting = opts.firstName ? `Hi ${opts.firstName},\n\n` : '';
  return `${greeting}The team at ${opts.schoolName} has started your enrollment for the 2026-27 school year.

The student start date and grade level are already filled in — please review the rest of the form, pick your tuition + payment plan, sign, and submit.

Open your enrollment:
${opts.inviteUrl}

This link is unique to your family.`;
}

function escape(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '&' ? '&amp;' :
    c === '"' ? '&quot;' :
    '&#39;');
}
