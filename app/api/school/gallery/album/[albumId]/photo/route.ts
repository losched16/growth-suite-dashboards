// POST /api/school/gallery/album/{albumId}/photo — add ONE photo to an
// album. The browser resizes each image before upload (full <= 1600px,
// thumb <= 500px, JPEG) and posts both, so the server just validates
// ownership + stores the bytes. One photo per request keeps per-photo
// progress + error handling simple in the uploader UI.
//
// Body (multipart/form-data):
//   full         — resized full JPEG            required
//   thumb        — resized thumbnail JPEG       required
//   width,height,thumb_width,thumb_height — integers (optional)
//   caption      — optional caption

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type Params = Promise<{ albumId: string }>;

const MAX_FULL = 10 * 1024 * 1024; // 10 MB — plenty for a 1600px JPEG
const MAX_THUMB = 2 * 1024 * 1024;

function intOrNull(v: FormDataEntryValue | null): number | null {
  const n = Number(String(v ?? ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { albumId } = await params;
  if (!/^[0-9a-fA-F-]{36}$/.test(albumId)) {
    return NextResponse.json({ error: 'bad_album' }, { status: 400 });
  }
  const { rows: own } = await query<{ id: string }>(
    `SELECT id FROM website_gallery_albums WHERE id = $1 AND school_id = $2`,
    [albumId, session.school_id],
  );
  if (own.length === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  let fd: FormData;
  try { fd = await request.formData(); }
  catch { return NextResponse.json({ error: 'invalid_form_data' }, { status: 400 }); }

  const full = fd.get('full');
  const thumb = fd.get('thumb');
  if (!(full instanceof File) || full.size === 0) {
    return NextResponse.json({ error: 'missing_full' }, { status: 400 });
  }
  if (!(thumb instanceof File) || thumb.size === 0) {
    return NextResponse.json({ error: 'missing_thumb' }, { status: 400 });
  }
  if (full.size > MAX_FULL || thumb.size > MAX_THUMB) {
    return NextResponse.json({ error: 'too_large' }, { status: 400 });
  }

  const fullBytes = Buffer.from(await full.arrayBuffer());
  const thumbBytes = Buffer.from(await thumb.arrayBuffer());
  const caption = String(fd.get('caption') ?? '').trim().slice(0, 300) || null;

  const { rows } = await query<{ id: string }>(
    `INSERT INTO website_gallery_photos
       (album_id, school_id, full_bytes, thumb_bytes, mime,
        width, height, thumb_width, thumb_height, caption, size_bytes, position)
     VALUES ($1, $2, $3, $4, 'image/jpeg', $5, $6, $7, $8, $9, $10,
             (SELECT COALESCE(MAX(position), 0) + 10 FROM website_gallery_photos WHERE album_id = $1))
     RETURNING id`,
    [
      albumId, session.school_id, fullBytes, thumbBytes,
      intOrNull(fd.get('width')), intOrNull(fd.get('height')),
      intOrNull(fd.get('thumb_width')), intOrNull(fd.get('thumb_height')),
      caption, fullBytes.length,
    ],
  );

  // Adopt the first uploaded photo as the album cover automatically.
  await query(
    `UPDATE website_gallery_albums
        SET cover_photo_id = $1, updated_at = now()
      WHERE id = $2 AND cover_photo_id IS NULL`,
    [rows[0].id, albumId],
  );

  return NextResponse.json({ photo: { id: rows[0].id } }, { status: 201 });
}
