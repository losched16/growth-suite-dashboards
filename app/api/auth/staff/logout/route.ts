// POST /api/auth/staff/logout — clear the school session, back to /login.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { SCHOOL_SESSION_COOKIE } from '@/lib/auth/school';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const response = NextResponse.redirect(new URL('/staff', request.url), 303);
  response.cookies.set({ name: SCHOOL_SESSION_COOKIE, value: '', path: '/', maxAge: 0 });
  return response;
}
