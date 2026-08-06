// GET /api/school/gallery/photo/{photoId}/image?size=thumb|full — image
// bytes for the operator's OWN photos, regardless of publish state, so
// the Gallery Manager can preview albums that aren't live yet. School-
// session auth + ownership check (the public /api/website/... endpoint
// stays published-only).

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ photoId: string }>;

export async function GET(request: NextRequest, { params }: { params: Params }) {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { photoId } = await params;
  if (!/^[0-9a-fA-F-]{36}$/.test(photoId)) {
    return NextResponse.json({ error: 'bad_id' }, { status: 400 });
  }
  const size = request.nextUrl.searchParams.get('size') === 'full' ? 'full' : 'thumb';
  const col = size === 'full' ? 'full_bytes' : 'thumb_bytes';

  const { rows } = await query<{ bytes: Buffer; mime: string }>(
    `SELECT ${col} AS bytes, mime FROM website_gallery_photos
      WHERE id = $1 AND school_id = $2`,
    [photoId, session.school_id],
  );
  if (rows.length === 0 || !rows[0].bytes) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return new NextResponse(new Uint8Array(rows[0].bytes), {
    status: 200,
    headers: {
      'Content-Type': rows[0].mime || 'image/jpeg',
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, max-age=60',
    },
  });
}
