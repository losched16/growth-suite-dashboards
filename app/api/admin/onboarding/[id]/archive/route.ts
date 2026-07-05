// POST /api/admin/onboarding/[id]/archive — operator archives/unarchives an
// onboarding (soft). Archived rows leave the active board and stop getting
// reminders. Operator-only.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { query } from '@/lib/db';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ id: string }>;

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const ck = await cookies();
  if (!verifySessionToken(ck.get(SESSION_COOKIE)?.value)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  const fd = await request.formData();
  const archive = String(fd.get('archive') ?? '') === '1';

  await query(
    `UPDATE school_onboarding SET archived_at = ${archive ? 'now()' : 'NULL'}, updated_at = now() WHERE id = $1`,
    [id],
  );

  const url = request.nextUrl.clone();
  url.pathname = archive ? '/admin/onboarding' : `/admin/onboarding/${id}`;
  url.search = '';
  url.searchParams.set('msg', archive ? 'Onboarding archived.' : 'Onboarding restored.');
  return NextResponse.redirect(url, 303);
}
