// GET /api/website/gallery/{locationId} — PUBLIC gallery feed for a
// school's marketing website (e.g. FLMA's static site fetches this and
// renders album cards + a lightbox client-side).
//
// Public + CORS-open on purpose: this is marketing content the school
// wants on the open web. Only PUBLISHED albums are returned, and only
// photo METADATA (ids + dimensions + captions) — the image bytes come
// from /api/website/gallery/photo/{id}. Unknown location => empty list,
// so a site can ship the gallery widget before the school adds a photo.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ locationId: string }>;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  // Brief browser cache so a busy gallery page doesn't hammer the DB;
  // the image bytes themselves are cached hard (immutable) downstream.
  'Cache-Control': 'public, max-age=120, s-maxage=120',
};

interface AlbumRow {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  cover_photo_id: string | null;
}
interface PhotoRow {
  id: string;
  album_id: string;
  width: number | null;
  height: number | null;
  caption: string | null;
}

export async function GET(_request: NextRequest, { params }: { params: Params }) {
  const { locationId } = await params;
  try {
    const { rows: schoolRows } = await query<{ id: string; name: string }>(
      `SELECT id, name FROM schools WHERE ghl_location_id = $1`,
      [locationId],
    );
    if (schoolRows.length === 0) {
      return NextResponse.json({ school: null, albums: [] }, { headers: CORS });
    }
    const school = schoolRows[0];

    const { rows: albums } = await query<AlbumRow>(
      `SELECT id, slug, title, description, cover_photo_id
         FROM website_gallery_albums
        WHERE school_id = $1 AND is_published = true
        ORDER BY position, created_at`,
      [school.id],
    );
    if (albums.length === 0) {
      return NextResponse.json(
        { school: { name: school.name }, albums: [] },
        { headers: CORS },
      );
    }

    const albumIds = albums.map((a) => a.id);
    const { rows: photos } = await query<PhotoRow>(
      `SELECT id, album_id, width, height, caption
         FROM website_gallery_photos
        WHERE album_id = ANY($1::uuid[])
        ORDER BY position, created_at`,
      [albumIds],
    );

    const byAlbum = new Map<string, PhotoRow[]>();
    for (const p of photos) {
      const ex = byAlbum.get(p.album_id) ?? [];
      ex.push(p);
      byAlbum.set(p.album_id, ex);
    }

    const out = albums
      .map((a) => {
        const ps = byAlbum.get(a.id) ?? [];
        const cover = a.cover_photo_id && ps.some((p) => p.id === a.cover_photo_id)
          ? a.cover_photo_id
          : ps[0]?.id ?? null;
        return {
          slug: a.slug,
          title: a.title,
          description: a.description,
          count: ps.length,
          cover_photo_id: cover,
          photos: ps.map((p) => ({
            id: p.id,
            width: p.width,
            height: p.height,
            caption: p.caption,
          })),
        };
      })
      // Hide empty albums from the public site — an album with no photos
      // yet is just noise for visitors (the school still sees it in the
      // manager and can add photos).
      .filter((a) => a.count > 0);

    return NextResponse.json(
      { school: { name: school.name }, albums: out },
      { headers: CORS },
    );
  } catch {
    return NextResponse.json({ school: null, albums: [] }, { headers: CORS });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
