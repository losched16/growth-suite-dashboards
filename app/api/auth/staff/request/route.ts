// POST /api/auth/staff/request — start a staff magic-link sign-in.
// Form field: email. Always redirects to /login?sent=1 regardless of
// whether the email matched (no account enumeration).

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { lookupStaffByEmail, issueStaffTokens, sendStaffLoginEmail } from '@/lib/auth/staff-magic-link';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const fd = await request.formData().catch(() => null);
  const email = String(fd?.get('email') ?? '').trim().toLowerCase();

  const done = NextResponse.redirect(new URL('/staff?sent=1', request.url), 303);
  if (!email || !email.includes('@')) return done;

  try {
    const matches = await lookupStaffByEmail(email);
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
    const issued = await issueStaffTokens(matches, ip);
    const origin = new URL(request.url).origin;
    for (const { match, token } of issued) {
      await sendStaffLoginEmail({
        to: match.email,
        schoolName: match.school_name,
        loginUrl: `${origin}/api/auth/staff/verify?token=${token}`,
      });
    }
  } catch (e) {
    // Still report success to the user — log for ops.
    console.error('[staff/request] failed:', e instanceof Error ? e.message : String(e));
  }
  return done;
}
