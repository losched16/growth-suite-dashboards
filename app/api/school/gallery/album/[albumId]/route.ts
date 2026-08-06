// PATCH  /api/school/gallery/album/{albumId} — rename / publish-toggle /
//        set cover / reorder an album.  Body (JSON), any subset of:
//        { title, description, is_published, cover_photo_id, position }
// DELETE /api/school/gallery/album/{albumId} — delete album + its photos
//        (ON DELETE CASCADE).
//
// Both verify the album belongs to the caller's school (school_id from
// the session cookie) before touching anything.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ albumId: string }>;

async function ownedAlbum(albumId: string, schoolId: string): Promise<boolean> {
  if (!/^[0-9a-fA-F-]{36}$/.test(albumId)) return false;
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM website_gallery_albums WHERE id = $1 AND school_id = $2`,
    [albumId, schoolId],
  );
  return rows.length > 0;
}

export async function PATCH(request: NextRequest, { params }: { params: Params }) {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { albumId } = await params;
  if (!(await ownedAlbum(albumId, session.school_id))) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'bad_json' }, { status: 400 }); }

  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (typeof body.title === 'string' && body.title.trim()) {
    sets.push(`title = $${i++}`); vals.push(body.title.trim().slice(0, 120));
  }
  if ('description' in body) {
    sets.push(`description = $${i++}`);
    vals.push(String(body.description ?? '').trim() || null);
  }
  if (typeof body.is_published === 'boolean') {
    sets.push(`is_published = $${i++}`); vals.push(body.is_published);
  }
  if (typeof body.position === 'number' && Number.isFinite(body.position)) {
    sets.push(`position = $${i++}`); vals.push(Math.round(body.position));
  }
  if ('cover_photo_id' in body) {
    const cov = body.cover_photo_id;
    if (cov === null) { sets.push(`cover_photo_id = $${i++}`); vals.push(null); }
    else if (typeof cov === 'string' && /^[0-9a-fA-F-]{36}$/.test(cov)) {
      // Only accept a cover that actually belongs to this album.
      const { rows } = await query<{ id: string }>(
        `SELECT id FROM website_gallery_photos WHERE id = $1 AND album_id = $2`,
        [cov, albumId],
      );
      if (rows.length) { sets.push(`cover_photo_id = $${i++}`); vals.push(cov); }
    }
  }
  if (sets.length === 0) return NextResponse.json({ error: 'nothing_to_update' }, { status: 400 });

  sets.push(`updated_at = now()`);
  vals.push(albumId);
  await query(
    `UPDATE website_gallery_albums SET ${sets.join(', ')} WHERE id = $${i}`,
    vals,
  );
  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: NextRequest, { params }: { params: Params }) {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { albumId } = await params;
  if (!(await ownedAlbum(albumId, session.school_id))) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  await query(`DELETE FROM website_gallery_albums WHERE id = $1`, [albumId]);
  return NextResponse.json({ ok: true });
}
