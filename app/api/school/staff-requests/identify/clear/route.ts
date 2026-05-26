// POST /api/school/staff-requests/identify/clear
//   "Switch teacher" — clears the gsd_teacher_email + gsd_teacher_name
//   cookies and redirects back to the staff-requests landing so the
//   next person can identify themselves.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { TEACHER_EMAIL_COOKIE, TEACHER_NAME_COOKIE } from '@/lib/auth/teacher-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const fd = await request.formData().catch(() => null);
  const returnTo = fd ? String(fd.get('return_to') ?? '').trim() : '';
  const safeReturn = returnTo && /^\/school\/[A-Za-z0-9_-]+\//.test(returnTo)
    ? returnTo
    : `/school/${session.ghl_location_id}/staff-requests?chrome=none`;

  const res = NextResponse.redirect(new URL(safeReturn, request.url), 303);
  res.cookies.set({ name: TEACHER_EMAIL_COOKIE, value: '', maxAge: 0, path: '/', sameSite: 'none', secure: true, partitioned: true });
  res.cookies.set({ name: TEACHER_NAME_COOKIE,  value: '', maxAge: 0, path: '/', sameSite: 'none', secure: true, partitioned: true });
  return res;
}
