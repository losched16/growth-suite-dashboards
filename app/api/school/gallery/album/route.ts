// POST /api/school/gallery/album — create a new gallery album for the
// operator's own school (school_id from the school session cookie, never
// the URL, so nobody can create albums under another school).
//
// Body (JSON): { title: string, description?: string }
// Returns: { album: { id, slug, title, description, is_published } }

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'album';
}

export async function POST(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: { title?: string; description?: string };
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'bad_json' }, { status: 400 }); }

  const title = String(body.title ?? '').trim();
  const description = String(body.description ?? '').trim() || null;
  if (!title) return NextResponse.json({ error: 'Title is required.' }, { status: 400 });
  if (title.length > 120) return NextResponse.json({ error: 'Title is too long.' }, { status: 400 });

  // Unique slug within the school: base, then base-2, base-3, ...
  const base = slugify(title);
  const { rows: existing } = await query<{ slug: string }>(
    `SELECT slug FROM website_gallery_albums WHERE school_id = $1 AND slug LIKE $2`,
    [session.school_id, `${base}%`],
  );
  const taken = new Set(existing.map((r) => r.slug));
  let slug = base;
  let n = 2;
  while (taken.has(slug)) { slug = `${base}-${n++}`; }

  const { rows } = await query<{
    id: string; slug: string; title: string; description: string | null; is_published: boolean;
  }>(
    `INSERT INTO website_gallery_albums (school_id, slug, title, description, position)
     VALUES ($1, $2, $3, $4,
             (SELECT COALESCE(MAX(position), 0) + 10 FROM website_gallery_albums WHERE school_id = $1))
     RETURNING id, slug, title, description, is_published`,
    [session.school_id, slug, title, description],
  );

  return NextResponse.json({ album: rows[0] }, { status: 201 });
}
