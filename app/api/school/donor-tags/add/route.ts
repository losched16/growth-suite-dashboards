// Add a donor tag — called from the DonorDashboard accordion's inline
// tag editor inside the school iframe. Authed via the school session
// cookie (matches /school/* gate). School ID is read from the cookie so
// the operator can't accidentally tag a donor on the wrong school.

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
  const tag = normalizeTag(String(fd.get('tag') ?? ''));
  const note = String(fd.get('note') ?? '').trim() || null;
  if (!dpDonorId || !tag) {
    return new NextResponse('missing dp_donor_id or tag', { status: 400 });
  }

  await query(
    `INSERT INTO donor_tags (school_id, dp_donor_id, tag, note)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (school_id, dp_donor_id, tag) DO NOTHING`,
    [session.school_id, dpDonorId, tag, note],
  );

  return NextResponse.json({ ok: true, tag });
}

function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
