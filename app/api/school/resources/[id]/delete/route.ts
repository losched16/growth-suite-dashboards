// POST /api/school/resources/{id}/delete
//
// Soft-delete a school resource. Sets is_active=false so the file
// stops appearing in the parent portal but stays in the table for
// audit / undelete. (To undelete: flip is_active back to true via a
// direct DB update — no UI button yet, since "we deleted by mistake"
// is rare enough that a quick re-upload is usually faster.)

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ id: string }>;

function bounce(request: NextRequest, returnTo: string | null, qs: { msg?: string; err?: string }) {
  const fallback = `/school/_/resources`;
  const base = returnTo && /^\/school\/[A-Za-z0-9_-]+\//.test(returnTo) ? returnTo : fallback;
  const url = new URL(base, request.url);
  if (qs.msg) url.searchParams.set('msg', qs.msg);
  if (qs.err) url.searchParams.set('err', qs.err);
  return NextResponse.redirect(url, 303);
}

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { id } = await params;
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let fd: FormData;
  try { fd = await request.formData(); }
  catch { fd = new FormData(); }
  const returnTo = String(fd.get('return_to') ?? '').trim() || null;

  const { rows } = await query<{ title: string }>(
    `UPDATE school_documents
        SET is_active = false, updated_at = now()
      WHERE id = $1 AND school_id = $2 AND is_active = true
      RETURNING title`,
    [id, session.school_id],
  );
  if (rows.length === 0) {
    return bounce(request, returnTo, { err: 'Document not found (or already removed).' });
  }
  return bounce(request, returnTo, { msg: `Removed "${rows[0].title}" from the parent portal.` });
}
