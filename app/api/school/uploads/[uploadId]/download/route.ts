// GET /api/school/uploads/{uploadId}/download
//
// Streams a parent-uploaded document's bytea back to the browser.
// School-session-authed; school_id is enforced in the WHERE so a school
// can only download its own families' uploads. Mirrors the operator-side
// /api/admin/uploads/{id}/download but for the embedded /school context.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { checkEmbedToken } from '@/lib/auth/embed';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ uploadId: string }>;

export async function GET(request: NextRequest, { params }: { params: Params }) {
  const { uploadId } = await params;
  const ck = await cookies();

  const { rows } = await query<{
    school_id: string;
    ghl_location_id: string | null;
    original_filename: string;
    mime_type: string;
    contents: Buffer;
    size_bytes: number;
  }>(
    `SELECT u.school_id, s.ghl_location_id,
            u.original_filename, u.mime_type, u.contents, u.size_bytes
       FROM parent_uploads u JOIN schools s ON s.id = u.school_id
      WHERE u.id = $1`,
    [uploadId],
  );
  if (rows.length === 0 || !rows[0].contents) {
    return new NextResponse('not found', { status: 404 });
  }

  // Operator (back-office) OR a school session for the upload's school
  // OR the embed token — downloads open in a NEW TAB where the iframe's
  // partitioned session cookie doesn't follow.
  const operator = !!verifySessionToken(ck.get(SESSION_COOKIE)?.value);
  const school = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  const sessionOk = !!school && school.school_id === rows[0].school_id;
  const embedToken = request.nextUrl.searchParams.get('embed_token');
  const embedOk = !!embedToken && !!rows[0].ghl_location_id
    && checkEmbedToken(rows[0].ghl_location_id, embedToken);
  if (!operator && !sessionOk && !embedOk) return new NextResponse('unauthorized', { status: 401 });

  const name = rows[0].original_filename || 'document';
  const encName = encodeURIComponent(name).replace(/'/g, '%27');
  const buf = rows[0].contents;
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

  return new NextResponse(ab as ArrayBuffer, {
    status: 200,
    headers: {
      'Content-Type': rows[0].mime_type || 'application/octet-stream',
      'Content-Length': String(rows[0].size_bytes ?? buf.byteLength),
      'Content-Disposition': `attachment; filename="${name.replace(/"/g, '')}"; filename*=UTF-8''${encName}`,
      'Cache-Control': 'private, no-store',
    },
  });
}
