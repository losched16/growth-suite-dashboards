// POST /api/school/staff-requests/identify
//   Sets the gsd_teacher_email cookie so subsequent submissions get
//   attached to this teacher. Triggered by the IdentityPicker on the
//   /staff-requests landing.
//
// DELETE /api/school/staff-requests/identify
//   Clears the cookie (the "switch teacher" link). The teacher gets
//   re-prompted to pick on the next submit.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import {
  TEACHER_EMAIL_COOKIE,
  TEACHER_NAME_COOKIE,
  TEACHER_COOKIE_TTL_S,
  isValidEmail,
  DGM_STAFF_DIRECTORY,
} from '@/lib/auth/teacher-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  // Must have a valid school session — keeps the cookie from being
  // set by anyone hitting the URL directly.
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const fd = await request.formData().catch(() => null);
  if (!fd) return NextResponse.json({ error: 'invalid_form_data' }, { status: 400 });

  const email = String(fd.get('teacher_email') ?? '').trim().toLowerCase();
  const nameInput = String(fd.get('teacher_name') ?? '').trim();
  const returnTo = String(fd.get('return_to') ?? '').trim();

  if (!isValidEmail(email)) {
    return NextResponse.json({ error: 'invalid_email' }, { status: 400 });
  }

  // Use the directory's friendly name when the email matches one we know,
  // otherwise fall back to whatever the user typed (Other path).
  const known = DGM_STAFF_DIRECTORY.find((s) => s.email === email);
  const name = known?.name ?? nameInput ?? '';

  // Where to redirect after identifying. Default = the staff-requests
  // landing inside the iframe so they see the form picker.
  const safeReturn = returnTo && /^\/school\/[A-Za-z0-9_-]+\//.test(returnTo)
    ? returnTo
    : `/school/${session.ghl_location_id}/staff-requests?chrome=none`;

  const res = NextResponse.redirect(new URL(safeReturn, request.url), 303);
  // SameSite=None + Secure + Partitioned so the cookie survives in the
  // cross-site GHL iframe (same approach as the school session cookie).
  res.cookies.set({
    name: TEACHER_EMAIL_COOKIE,
    value: email,
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    path: '/',
    maxAge: TEACHER_COOKIE_TTL_S,
    partitioned: true,
  });
  res.cookies.set({
    name: TEACHER_NAME_COOKIE,
    value: name,
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    path: '/',
    maxAge: TEACHER_COOKIE_TTL_S,
    partitioned: true,
  });
  return res;
}

export async function DELETE() {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set({ name: TEACHER_EMAIL_COOKIE, value: '', maxAge: 0, path: '/', sameSite: 'none', secure: true, partitioned: true });
  res.cookies.set({ name: TEACHER_NAME_COOKIE,  value: '', maxAge: 0, path: '/', sameSite: 'none', secure: true, partitioned: true });
  return res;
}
