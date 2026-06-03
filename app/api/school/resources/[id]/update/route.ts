// POST /api/school/resources/{id}/update
//
// Rename / re-categorize / re-describe a school_documents row. Does
// NOT replace the file payload — to update the file itself, delete +
// re-upload. (Keeping the file editable in-place is straightforward to
// add later, but the cleaner UX is "version bump = new upload".)
//
// Body (multipart):
//   title       — required
//   description — optional, empty clears it
//   category    — optional, empty clears it (→ "Other")
//   return_to   — optional redirect target

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
  catch { return NextResponse.json({ error: 'invalid_form_data' }, { status: 400 }); }

  const title = String(fd.get('title') ?? '').trim();
  const descriptionRaw = String(fd.get('description') ?? '').trim();
  const categoryRaw = String(fd.get('category') ?? '').trim();
  const returnTo = String(fd.get('return_to') ?? '').trim() || null;

  if (!title) return bounce(request, returnTo, { err: 'Title cannot be empty.' });

  const { rowCount } = await query(
    `UPDATE school_documents
        SET title = $3,
            description = NULLIF($4, ''),
            category = NULLIF($5, ''),
            updated_at = now()
      WHERE id = $1 AND school_id = $2`,
    [id, session.school_id, title, descriptionRaw, categoryRaw],
  );
  if (rowCount === 0) {
    return bounce(request, returnTo, { err: 'Document not found.' });
  }

  return bounce(request, returnTo, { msg: `Updated "${title}".` });
}
