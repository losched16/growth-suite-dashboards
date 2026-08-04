// GET /api/school/staff-requests/files/[fileId]
//
// Streams a staff-request file attachment (photo, PDF) back to the
// requester. Auth = valid school session for the SAME school the file
// belongs to. Used by Lexi's inbox to render an <img> / link for any
// attachment the teacher uploaded with the incident report.
//
// Stored as bytea in portal_form_submission_files — see
// app/api/school/staff-requests/submit/route.ts for the write path.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { query } from '@/lib/db';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { checkEmbedToken } from '@/lib/auth/embed';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ fileId: string }>;

export async function GET(req: NextRequest, { params }: { params: Params }) {
  const { fileId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(fileId)) {
    return NextResponse.json({ error: 'bad_file_id' }, { status: 400 });
  }

  const { rows } = await query<{
    school_id: string; ghl_location_id: string | null;
    contents: Buffer; mime_type: string; original_filename: string; size_bytes: number;
  }>(
    `SELECT f.school_id, s.ghl_location_id,
            f.contents, f.mime_type, f.original_filename, f.size_bytes
       FROM portal_form_submission_files f JOIN schools s ON s.id = f.school_id
      WHERE f.id = $1`,
    [fileId],
  );
  if (rows.length === 0) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const row = rows[0];

  // School session for the file's school OR the embed token — file links
  // open in a new tab from inside the CRM iframe, where the partitioned
  // session cookie doesn't follow.
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  const sessionOk = !!session && session.school_id === row.school_id;
  const embedToken = req.nextUrl.searchParams.get('embed_token');
  const embedOk = !!embedToken && !!row.ghl_location_id && checkEmbedToken(row.ghl_location_id, embedToken);
  if (!sessionOk && !embedOk) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  return new NextResponse(new Uint8Array(row.contents), {
    status: 200,
    headers: {
      'Content-Type': row.mime_type || 'application/octet-stream',
      'Content-Length': String(row.size_bytes),
      'Content-Disposition': `inline; filename="${row.original_filename.replace(/[^a-z0-9._-]/gi, '_')}"`,
      // Short cache so the inbox can render the image without a
      // re-fetch every render, but doesn't outlive any policy change.
      'Cache-Control': 'private, max-age=300',
    },
  });
}
