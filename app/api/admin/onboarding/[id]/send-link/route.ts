// POST /api/admin/onboarding/[id]/send-link — operator emails the school its
// onboarding link. Operator-only.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { sendOnboardingLinkEmail } from '@/lib/onboarding/email';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ id: string }>;

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const ck = await cookies();
  if (!verifySessionToken(ck.get(SESSION_COOKIE)?.value)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { id } = await params;

  const back = (q: { msg?: string; err?: string }) => {
    const url = request.nextUrl.clone();
    url.pathname = `/admin/onboarding/${id}`;
    url.search = '';
    if (q.msg) url.searchParams.set('msg', q.msg);
    if (q.err) url.searchParams.set('err', q.err);
    return NextResponse.redirect(url, 303);
  };

  try {
    const ok = await sendOnboardingLinkEmail(id);
    return ok ? back({ msg: 'Onboarding link emailed to the school.' }) : back({ err: 'Onboarding not found.' });
  } catch (e) {
    return back({ err: `Email failed: ${e instanceof Error ? e.message : String(e)}` });
  }
}
