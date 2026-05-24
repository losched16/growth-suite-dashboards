// Remove a donor tag. Mirror of /api/school/donor-tags/add.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return new NextResponse('unauthorized', { status: 401 });

  const fd = await request.formData();
  const dpDonorId = String(fd.get('dp_donor_id') ?? '').trim();
  const tag = String(fd.get('tag') ?? '').trim().toLowerCase();
  if (!dpDonorId || !tag) {
    return new NextResponse('missing dp_donor_id or tag', { status: 400 });
  }

  await query(
    `DELETE FROM donor_tags
     WHERE school_id = $1 AND dp_donor_id = $2 AND tag = $3`,
    [session.school_id, dpDonorId, tag],
  );

  return NextResponse.json({ ok: true });
}
