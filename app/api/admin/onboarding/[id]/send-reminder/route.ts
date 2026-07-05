// POST /api/admin/onboarding/[id]/send-reminder — operator manually nudges a
// school now (outside the nightly cron cadence). Operator-only. Sends the
// reminder email with the current outstanding count and stamps last_reminded_at
// so the cron doesn't double-send right after.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { query } from '@/lib/db';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { computeOnboarding } from '@/lib/onboarding/status';
import { sendOnboardingReminderEmail } from '@/lib/onboarding/email';

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
    const snap = await computeOnboarding(id);
    if (!snap) return back({ err: 'Onboarding not found.' });
    const outstanding = snap.tasks.filter((t) => t.owner === 'school' && t.status === 'not_started').length;
    if (outstanding === 0) return back({ err: 'Nothing outstanding for the school — no reminder sent.' });

    await sendOnboardingReminderEmail(id, outstanding);
    await query(`UPDATE school_onboarding SET last_reminded_at = now() WHERE id = $1`, [id]);
    return back({ msg: `Reminder sent (${outstanding} item${outstanding === 1 ? '' : 's'} outstanding).` });
  } catch (e) {
    return back({ err: `Reminder failed: ${e instanceof Error ? e.message : String(e)}` });
  }
}
