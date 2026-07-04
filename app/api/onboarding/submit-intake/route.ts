// POST /api/onboarding/submit-intake — a school submits an intake vocabulary
// (grade levels / programs / schedules / classrooms) as a list of values.
// Stored on onboarding_task_state.payload; an operator later pushes it into
// the GHL sub-account (lib/onboarding/apply-intake.ts). Token-authed.

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

// One value per line OR comma-separated. Trim, drop blanks, de-dupe.
function parseValues(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of raw.split(/[\n,]/)) {
    const v = piece.trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v.slice(0, 100));
    if (out.length >= 50) break;
  }
  return out;
}

export async function POST(request: NextRequest) {
  const fd = await request.formData();
  const token = String(fd.get('token') ?? '');
  const onboardingId = verifyOnboardingToken(token);
  if (!onboardingId) return new NextResponse('Link expired or invalid.', { status: 401 });

  const taskKey = String(fd.get('task_key') ?? '').trim();
  const task = CHECKLIST_BY_KEY[taskKey];
  if (!task || task.type !== 'intake') {
    return back(request, token, { err: 'Unknown intake step.' });
  }

  const values = parseValues(String(fd.get('values') ?? ''));
  const min = task.intake.minItems ?? 1;
  if (values.length < min) {
    return back(request, token, { err: `Please enter at least ${min} value${min === 1 ? '' : 's'} for "${task.title}".` });
  }

  await query(
    `INSERT INTO onboarding_task_state (onboarding_id, task_key, status, payload, submitted_at, updated_at)
     VALUES ($1, $2, 'submitted', $3::jsonb, now(), now())
     ON CONFLICT (onboarding_id, task_key) DO UPDATE SET
       status = 'submitted',
       payload = EXCLUDED.payload,
       submitted_at = now(),
       -- resubmitting invalidates any prior GHL apply so ops re-pushes
       applied_to_ghl_at = NULL,
       updated_at = now()`,
    [onboardingId, taskKey, JSON.stringify({ values })],
  );

  return back(request, token, { msg: `Saved ${values.length} value${values.length === 1 ? '' : 's'} for "${task.title}".` });
}
