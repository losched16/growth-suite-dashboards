// POST /api/admin/schools/{schoolId}/notifications/count
//
// Live "this reaches N parents" preview for the compose screen. Same
// audience resolution as send, just COUNTed.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { countAudience, sanitizeAudience } from '@/lib/notifications/audience';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string }>;

async function authorized(schoolId: string): Promise<boolean> {
  const ck = await cookies();
  if (verifySessionToken(ck.get(SESSION_COOKIE)?.value)) return true;
  const ss = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  return !!ss && ss.school_id === schoolId;
}

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId } = await params;
  if (!(await authorized(schoolId))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: { audience?: unknown } = {};
  try { body = await request.json(); } catch { /* default */ }

  const audience = sanitizeAudience(body.audience);
  if (!audience) return NextResponse.json({ count: 0 });

  const count = await countAudience(schoolId, audience);
  return NextResponse.json({ count });
}
