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
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ uploadId: string }>;

export async function GET(_request: NextRequest, { params }: { params: Params }) {
  const { uploadId } = await params;
  const ck = await cookies();

  // Operator (back-office) OR a school session. For a school session we
  // scope the query to that school; an operator may pull any upload.
  const operator = !!verifySessionToken(ck.get(SESSION_COOKIE)?.value);
  const school = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!operator && !school) return new NextResponse('unauthorized', { status: 401 });

  const where = operator ? 'id = $1' : 'id = $1 AND school_id = $2';
  const args: unknown[] = operator ? [uploadId] : [uploadId, school!.school_id];

  const { rows } = await query<{
    original_filename: string;
    mime_type: string;
    contents: Buffer;
    size_bytes: number;
  }>(
    `SELECT original_filename, mime_type, contents, size_bytes
       FROM parent_uploads WHERE ${where}`,
    args,
  );
  if (rows.length === 0 || !rows[0].contents) {
    return new NextResponse('not found', { status: 404 });
  }

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
