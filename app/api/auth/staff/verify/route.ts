// GET /api/auth/staff/verify?token=… — consume a staff magic link and
// mint the standard gsd_school_session cookie (the same session the
// GHL-embed exchange mints), then land on the school's dashboard home.
// sameSite=lax: staff sign-in is a top-level navigation, not an iframe.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { consumeStaffToken } from '@/lib/auth/staff-magic-link';
import { mintSchoolSession, SCHOOL_SESSION_COOKIE, SCHOOL_SESSION_TTL_S } from '@/lib/auth/school';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token') ?? '';
  const consumed = await consumeStaffToken(token).catch(() => null);
  if (!consumed) {
    return NextResponse.redirect(new URL('/staff?err=expired', request.url), 303);
  }

  const jwt = await mintSchoolSession({
    school_id: consumed.school_id,
    ghl_location_id: consumed.ghl_location_id,
    user_email: consumed.email,
    user_name: consumed.staff_name ?? consumed.email,
    via: 'staff',
  });

  const response = NextResponse.redirect(
    new URL(`/school/${consumed.ghl_location_id}`, request.url), 303,
  );
  response.cookies.set({
    name: SCHOOL_SESSION_COOKIE,
    value: jwt,
    httpOnly: true,
    secure: true,
    path: '/',
    sameSite: 'lax',
    maxAge: SCHOOL_SESSION_TTL_S,
  });
  return response;
}
