// POST /api/admin/onboarding/[id]/update — operator updates onboarding meta
// (op=meta) or signs off an ops-owned manual task (op=ops_task). Operator-only.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { query } from '@/lib/db';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { CHECKLIST_BY_KEY } from '@/lib/onboarding/checklist';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ id: string }>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const ck = await cookies();
  if (!verifySessionToken(ck.get(SESSION_COOKIE)?.value)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  const fd = await request.formData();
  const op = String(fd.get('op') ?? '').trim();

  const back = (q: { msg?: string; err?: string }) => {
    const url = request.nextUrl.clone();
    url.pathname = `/admin/onboarding/${id}`;
    url.search = '';
    if (q.msg) url.searchParams.set('msg', q.msg);
    if (q.err) url.searchParams.set('err', q.err);
    return NextResponse.redirect(url, 303);
  };

  if (op === 'meta') {
    const schoolIdRaw = String(fd.get('school_id') ?? '').trim();
    const schoolId = schoolIdRaw === '' ? null : (UUID.test(schoolIdRaw) ? schoolIdRaw : undefined);
    if (schoolId === undefined) return back({ err: 'school_id must be a valid UUID (or blank).' });

    const ghlLocationId = String(fd.get('ghl_location_id') ?? '').trim() || null;
    const targetRaw = String(fd.get('target_launch_date') ?? '').trim();
    const target = /^\d{4}-\d{2}-\d{2}$/.test(targetRaw) ? targetRaw : null;
    const assigned = String(fd.get('assigned_ops_email') ?? '').trim().toLowerCase() || null;
    const notes = String(fd.get('notes') ?? '').trim().slice(0, 5000) || null;

    await query(
      `UPDATE school_onboarding
          SET school_id = $2, ghl_location_id = $3, target_launch_date = $4,
              assigned_ops_email = $5, notes = $6, updated_at = now()
        WHERE id = $1`,
      [id, schoolId, ghlLocationId, target, assigned, notes],
    );
    return back({ msg: 'Details saved.' });
  }

  if (op === 'ops_task') {
    const taskKey = String(fd.get('task_key') ?? '').trim();
    const task = CHECKLIST_BY_KEY[taskKey];
    if (!task || task.type !== 'manual' || task.owner !== 'ops') {
      return back({ err: 'Not an ops sign-off task.' });
    }
    const done = String(fd.get('done') ?? '') === '1';
    await query(
      `INSERT INTO onboarding_task_state (onboarding_id, task_key, status, reviewed_by_email, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (onboarding_id, task_key) DO UPDATE SET status = EXCLUDED.status, reviewed_by_email = EXCLUDED.reviewed_by_email, updated_at = now()`,
      [id, taskKey, done ? 'done' : 'pending', 'operator'],
    );
    return back({ msg: done ? 'Signed off.' : 'Sign-off removed.' });
  }

  return back({ err: `Unknown op: ${op}` });
}
