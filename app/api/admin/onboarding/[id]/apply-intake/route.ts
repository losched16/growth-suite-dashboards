// POST /api/admin/onboarding/[id]/apply-intake — operator pushes the school's
// submitted intake vocabularies into their GHL sub-account (picklist options).
// Operator-only. Wraps lib/onboarding/apply-intake.applyAllIntake.
//
// ⚠️ LIVE GHL WRITE — see lib/onboarding/apply-intake.ts. Test on a real
// sub-account before trusting; apply before importing the roster.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { applyAllIntake } from '@/lib/onboarding/apply-intake';

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
    const { applied, skipped } = await applyAllIntake(id, 'operator');
    const fieldsTouched = applied.reduce((n, a) => n + a.matchedCount, 0);
    if (applied.length === 0) {
      return back({ err: `No intake values to apply${skipped.length ? ` (${skipped.length} step(s) empty)` : ''}.` });
    }
    return back({
      msg: `Applied ${applied.length} vocabular${applied.length === 1 ? 'y' : 'ies'} to ${fieldsTouched} GHL field(s).`,
    });
  } catch (e) {
    return back({ err: `Apply failed: ${e instanceof Error ? e.message : String(e)}` });
  }
}
