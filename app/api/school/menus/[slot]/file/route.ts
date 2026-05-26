// GET /api/school/menus/[slot]/file
//
// Serves the current menu image for a slot (lunch-calendar /
// daily-snack-menu / harvest-of-the-month). Read access: any valid
// school session. Returns 404 when no upload exists yet — DgmMenusView
// then falls back to the bundled /public PNG.

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { query } from '@/lib/db';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { isValidSlot } from '@/lib/menus';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ slot: string }>;

export async function GET(_req: Request, { params }: { params: Params }) {
  const { slot } = await params;
  if (!isValidSlot(slot)) return NextResponse.json({ error: 'bad_slot' }, { status: 400 });

  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { rows } = await query<{ contents: Buffer; mime_type: string; original_filename: string; size_bytes: number }>(
    `SELECT contents, mime_type, original_filename, size_bytes
       FROM school_menu_assets
      WHERE school_id = $1 AND slot = $2`,
    [session.school_id, slot],
  );
  if (rows.length === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const r = rows[0];
  return new NextResponse(new Uint8Array(r.contents), {
    status: 200,
    headers: {
      'Content-Type': r.mime_type || 'image/png',
      'Content-Length': String(r.size_bytes),
      'Content-Disposition': `inline; filename="${r.original_filename.replace(/[^a-z0-9._-]/gi, '_')}"`,
      // Short cache so a re-upload propagates within minutes without
      // requiring a hard reload. The edit page also appends ?v=<ts>
      // to bust cache after a write.
      'Cache-Control': 'private, max-age=60',
    },
  });
}
