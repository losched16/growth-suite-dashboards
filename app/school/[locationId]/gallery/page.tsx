// /school/[locationId]/gallery
//
// Operator/school UI for the PUBLIC WEBSITE photo gallery. Create albums,
// drag-drop photos (resized in the browser before upload), publish/
// unpublish, delete. What's published here is what the school's marketing
// site shows via /api/website/gallery/{locationId}. Image bytes live on
// website_gallery_photos (bytea); see migration 092.

import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { Images } from 'lucide-react';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { query } from '@/lib/db';
import { GalleryManager, type AdminAlbum } from './GalleryManager';

export const dynamic = 'force-dynamic';

type Params = Promise<{ locationId: string }>;

interface AlbumRow {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  is_published: boolean;
  cover_photo_id: string | null;
}
interface PhotoRow {
  id: string;
  album_id: string;
  caption: string | null;
}

export default async function SchoolGalleryPage({ params }: { params: Params }) {
  const { locationId } = await params;

  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) notFound();

  const { rows: albumRows } = await query<AlbumRow>(
    `SELECT id, slug, title, description, is_published, cover_photo_id
       FROM website_gallery_albums
      WHERE school_id = $1
      ORDER BY position, created_at`,
    [school.id],
  );

  let photoRows: PhotoRow[] = [];
  if (albumRows.length) {
    const { rows } = await query<PhotoRow>(
      `SELECT id, album_id, caption
         FROM website_gallery_photos
        WHERE album_id = ANY($1::uuid[])
        ORDER BY position, created_at`,
      [albumRows.map((a) => a.id)],
    );
    photoRows = rows;
  }

  const byAlbum = new Map<string, PhotoRow[]>();
  for (const p of photoRows) {
    const ex = byAlbum.get(p.album_id) ?? [];
    ex.push(p);
    byAlbum.set(p.album_id, ex);
  }

  const albums: AdminAlbum[] = albumRows.map((a) => ({
    id: a.id,
    slug: a.slug,
    title: a.title,
    description: a.description,
    is_published: a.is_published,
    cover_photo_id: a.cover_photo_id,
    photos: (byAlbum.get(a.id) ?? []).map((p) => ({ id: p.id, caption: p.caption })),
  }));

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        <header className="space-y-1">
          <div className="flex items-center gap-2">
            <Images className="h-5 w-5 text-emerald-600" />
            <h1 className="text-xl font-semibold text-gray-900">Photo Gallery</h1>
          </div>
          <p className="text-sm text-gray-600">
            Create albums and add photos for your school&apos;s public website. Photos
            you <span className="font-semibold">publish</span> here appear on the site&apos;s
            Photo Gallery page automatically — no developer needed. Drag in as many
            photos as you like; we shrink them for fast loading as they upload.
          </p>
        </header>
        <GalleryManager locationId={locationId} initialAlbums={albums} />
      </div>
    </main>
  );
}
