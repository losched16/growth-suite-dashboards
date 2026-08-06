// PATCH  /api/school/gallery/photo/{photoId} — edit caption. Body: { caption }
// DELETE /api/school/gallery/photo/{photoId} — remove a single photo.
//
// Both verify the photo belongs to the caller's school. Deleting a photo
// that is an album's cover nulls the cover via ON DELETE SET NULL, so the
// public feed falls back to "first photo".

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ photoId: string }>;

async function ownedPhoto(photoId: string, schoolId: string): Promise<boolean> {
  if (!/^[0-9a-fA-F-]{36}$/.test(photoId)) return false;
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM website_gallery_photos WHERE id = $1 AND school_id = $2`,
    [photoId, schoolId],
  );
  return rows.length > 0;
}

export async function PATCH(request: NextRequest, { params }: { params: Params }) {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { photoId } = await params;
  if (!(await ownedPhoto(photoId, session.school_id))) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  let body: { caption?: string };
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'bad_json' }, { status: 400 }); }
  const caption = String(body.caption ?? '').trim().slice(0, 300) || null;
  await query(`UPDATE website_gallery_photos SET caption = $1 WHERE id = $2`, [caption, photoId]);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: NextRequest, { params }: { params: Params }) {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { photoId } = await params;
  if (!(await ownedPhoto(photoId, session.school_id))) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  await query(`DELETE FROM website_gallery_photos WHERE id = $1`, [photoId]);
  return NextResponse.json({ ok: true });
}
