import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { SESSION_COOKIE, checkPassword, createSessionToken } from '@/lib/auth/operator';

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const password = String(form.get('password') ?? '');

  if (!checkPassword(password)) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('error', '1');
    return NextResponse.redirect(url, 303);
  }

  const { value, expires } = createSessionToken();
  const url = request.nextUrl.clone();
  url.pathname = '/admin';
  url.search = '';
  const response = NextResponse.redirect(url, 303);
  response.cookies.set({
    name: SESSION_COOKIE,
    value,
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    expires,
  });
  return response;
}
