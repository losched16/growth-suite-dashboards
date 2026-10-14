// POST /api/school/parent/[parentId]/send-login-link
//
// Office "resend invite": emails the parent a fresh sign-in link. Schools
// kept asking how to resend an expired invite — the old links are
// single-use or short-lived, and there was no button for it. The link is a
// reusable (multi_use) token valid 7 days, the same shape the form-reminder
// emails use, so mail scanners pre-fetching it can't burn it. It lands the
// parent signed in; first-timers are prompted to set a password from the
// Family page as usual.
//
// Auth: operator session OR a school session scoped to the parent's own
// school. Mirrors reset-password.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { query } from '@/lib/db';
import { sendBrandedEmail } from '@/lib/email';
import { parentPortalBaseForSchool } from '@/lib/parent-portal-base';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Params = Promise<{ parentId: string }>;

const TTL_MS = 7 * 24 * 60 * 60 * 1000;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { parentId } = await params;

  const ck = await cookies();
  const isOperator = verifySessionToken(ck.get(SESSION_COOKIE)?.value);
  const schoolSession = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!isOperator && !schoolSession) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const { rows } = await query<{
    id: string; school_id: string; family_id: string;
    email: string | null; first_name: string | null; school_name: string;
  }>(
    `SELECT p.id, p.school_id, p.family_id, p.email, p.first_name, s.name AS school_name
       FROM parents p JOIN schools s ON s.id = p.school_id
      WHERE p.id = $1 AND p.status = 'active'`,
    [parentId],
  );
  const parent = rows[0];
  if (!parent) return NextResponse.json({ ok: false, error: 'parent_not_found' }, { status: 404 });
  if (!isOperator && schoolSession && parent.school_id !== schoolSession.school_id) {
    return NextResponse.json({ ok: false, error: 'cross_school_blocked' }, { status: 403 });
  }
  const email = parent.email?.trim().toLowerCase();
  if (!email) return NextResponse.json({ ok: false, error: 'parent_has_no_email' }, { status: 400 });

  const token = crypto.randomBytes(24).toString('base64url');
  await query(
    `INSERT INTO parent_magic_link_tokens
       (token, email, school_id, parent_id, expires_at, request_ip, request_user_agent, multi_use)
     VALUES ($1, $2, $3, $4, $5, 'office-resend', 'family-hub', true)`,
    [token, email, parent.school_id, parent.id, new Date(Date.now() + TTL_MS).toISOString()],
  );
  const base = await parentPortalBaseForSchool(parent.school_id);
  const link = `${base}/api/auth/verify?token=${encodeURIComponent(token)}`;

  const hi = parent.first_name ? `Hi ${parent.first_name},` : 'Hi,';
  const school = parent.school_name;
  try {
    await sendBrandedEmail({
      to: email,
      schoolId: parent.school_id,
      subject: `Your ${school} family portal sign-in link`,
      text: `${hi}\n\nHere is your sign-in link for the ${school} family portal:\n${link}\n\nThe link works for 7 days. After that, go to ${base} and sign in with this email address any time.\n`,
      html: `<p>${esc(hi)}</p><p>Here is your sign-in link for the ${esc(school)} family portal:</p>`
        + `<p><a href="${link}" style="display:inline-block;padding:10px 16px;background:#111827;color:#fff;border-radius:6px;text-decoration:none">Open the family portal</a></p>`
        + `<p style="color:#6b7280;font-size:13px">The link works for 7 days. After that, go to <a href="${base}">${esc(base.replace(/^https?:\/\//, ''))}</a> and sign in with this email address any time.</p>`,
    });
  } catch (err) {
    await query(`DELETE FROM parent_magic_link_tokens WHERE token = $1`, [token]);
    console.warn('[send-login-link] email failed:', err);
    return NextResponse.json({ ok: false, error: 'email_failed' }, { status: 502 });
  }

  try {
    await query(
      `INSERT INTO parent_portal_audit_log (school_id, parent_id, family_id, event_type, detail)
       VALUES ($1, $2, $3, 'login_link_sent_by_office', $4::jsonb)`,
      [parent.school_id, parent.id, parent.family_id, JSON.stringify({ by: isOperator ? 'operator' : 'school', email })],
    );
  } catch {
    // ignore
  }

  return NextResponse.json({ ok: true, email });
}
