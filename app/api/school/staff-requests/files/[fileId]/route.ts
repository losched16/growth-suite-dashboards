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
import { cookies } from 'next/headers';
import { query } from '@/lib/db';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ fileId: string }>;

export async function GET(_req: Request, { params }: { params: Params }) {
  const { fileId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(fileId)) {
    return NextResponse.json({ error: 'bad_file_id' }, { status: 400 });
  }
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { rows } = await query<{
    contents: Buffer; mime_type: string; original_filename: string; size_bytes: number;
  }>(
    `SELECT contents, mime_type, original_filename, size_bytes
       FROM portal_form_submission_files
      WHERE id = $1 AND school_id = $2`,
    [fileId, session.school_id],
  );
  if (rows.length === 0) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const row = rows[0];

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
