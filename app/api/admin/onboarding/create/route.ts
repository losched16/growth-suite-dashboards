// POST /api/admin/onboarding/create — operator creates a new school onboarding
// record (a lead, before the tenant exists). Operator-only. Redirects to the
// detail page where the shareable link is shown.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { query } from '@/lib/db';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  // /api/admin/* is NOT proxy-gated — self-auth here (security-plan lesson).
  const ck = await cookies();
  if (!verifySessionToken(ck.get(SESSION_COOKIE)?.value)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const fd = await request.formData();
  const schoolName = String(fd.get('school_name') ?? '').trim();
  const contactEmail = String(fd.get('contact_email') ?? '').trim().toLowerCase();
  const contactName = String(fd.get('contact_name') ?? '').trim() || null;
  const ghlLocationId = String(fd.get('ghl_location_id') ?? '').trim() || null;

  const back = (q: { msg?: string; err?: string }, id?: string) => {
    const url = request.nextUrl.clone();
    url.pathname = id ? `/admin/onboarding/${id}` : '/admin/onboarding';
    url.search = '';
    if (q.msg) url.searchParams.set('msg', q.msg);
    if (q.err) url.searchParams.set('err', q.err);
    return NextResponse.redirect(url, 303);
  };

  if (!schoolName || !contactEmail) {
    return back({ err: 'School name and contact email are required.' });
  }

  const { rows } = await query<{ id: string }>(
    `INSERT INTO school_onboarding (school_name, contact_email, contact_name, ghl_location_id, stage)
     VALUES ($1, $2, $3, $4, 'invited') RETURNING id`,
    [schoolName, contactEmail, contactName, ghlLocationId],
  );

  return back({ msg: `Onboarding started for ${schoolName}.` }, rows[0].id);
}
