// GET /api/website/gallery/photo/{id}?size=thumb|full — PUBLIC image bytes
// for a gallery photo. Default size is "full"; the album grid requests
// ?size=thumb for a light initial load and the lightbox fetches full.
//
// Only serves photos whose album is published, so unpublishing an album
// pulls its images off the open web too. Bytes are immutable per id, so
// we cache hard.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ id: string }>;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

export async function GET(request: NextRequest, { params }: { params: Params }) {
  const { id } = await params;
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) {
    return NextResponse.json({ error: 'bad_id' }, { status: 400, headers: CORS });
  }
  const size = request.nextUrl.searchParams.get('size') === 'thumb' ? 'thumb' : 'full';
  const col = size === 'thumb' ? 'thumb_bytes' : 'full_bytes';

  const { rows } = await query<{ bytes: Buffer; mime: string }>(
    `SELECT p.${col} AS bytes, p.mime
       FROM website_gallery_photos p
       JOIN website_gallery_albums a ON a.id = p.album_id
      WHERE p.id = $1 AND a.is_published = true`,
    [id],
  );
  if (rows.length === 0 || !rows[0].bytes) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: CORS });
  }

  return new NextResponse(new Uint8Array(rows[0].bytes), {
    status: 200,
    headers: {
      ...CORS,
      'Content-Type': rows[0].mime || 'image/jpeg',
      'Content-Disposition': 'inline',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
