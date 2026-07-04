// POST /api/onboarding/toggle-manual — a school checks off a manual
// acknowledgement task (e.g. "confirm everything looks right"). Token-authed.
// Only school-owned manual tasks can be toggled here; ops sign-offs are done
// from the ops board.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { verifyOnboardingToken } from '@/lib/onboarding/token';
import { CHECKLIST_BY_KEY } from '@/lib/onboarding/checklist';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function back(request: NextRequest, token: string, q: { msg?: string; err?: string }) {
  const url = request.nextUrl.clone();
  url.pathname = `/onboarding/${token}`;
  url.search = '';
  if (q.msg) url.searchParams.set('msg', q.msg);
  if (q.err) url.searchParams.set('err', q.err);
  return NextResponse.redirect(url, 303);
}

export async function POST(request: NextRequest) {
  const fd = await request.formData();
  const token = String(fd.get('token') ?? '');
  const onboardingId = verifyOnboardingToken(token);
  if (!onboardingId) return new NextResponse('Link expired or invalid.', { status: 401 });

  const taskKey = String(fd.get('task_key') ?? '').trim();
  const task = CHECKLIST_BY_KEY[taskKey];
  if (!task || task.type !== 'manual' || task.owner !== 'school') {
    return back(request, token, { err: 'That step can’t be checked here.' });
  }
  const done = String(fd.get('done') ?? '') === '1';

  await query(
    `INSERT INTO onboarding_task_state (onboarding_id, task_key, status, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (onboarding_id, task_key) DO UPDATE SET status = EXCLUDED.status, updated_at = now()`,
    [onboardingId, taskKey, done ? 'done' : 'pending'],
  );

  return back(request, token, { msg: done ? `Marked "${task.title}" done.` : `Unchecked "${task.title}".` });
}
