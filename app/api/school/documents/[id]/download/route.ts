// GET /api/school/documents/{id}/download
//
// Streams a student document's bytea back to the browser with proper
// content-disposition so the file downloads with its original name.
// School-session-authed; school_id is enforced via JOIN so an operator
// can't download docs from another school by guessing IDs.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ id: string }>;

export async function GET(_request: NextRequest, { params }: { params: Params }) {
  const { id } = await params;
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return new NextResponse('unauthorized', { status: 401 });

  const { rows } = await query<{
    file_name: string;
    mime_type: string;
    file_bytes: Buffer;
    size_bytes: number;
  }>(
    `SELECT file_name, mime_type, file_bytes, size_bytes
       FROM student_documents
      WHERE id = $1 AND school_id = $2`,
    [id, session.school_id],
  );
  if (rows.length === 0 || !rows[0].file_bytes) {
    return new NextResponse('not found', { status: 404 });
  }

  // Encode the filename so non-ASCII characters survive. Use the
  // RFC-5987 form for filename* — works in every modern browser.
  const encName = encodeURIComponent(rows[0].file_name).replace(/'/g, '%27');

  // NextResponse's BodyInit type doesn't include Buffer / Uint8Array
  // generically in some TS lib targets — convert to ArrayBuffer for a
  // clean BodyInit value.
  const ab = rows[0].file_bytes.buffer.slice(
    rows[0].file_bytes.byteOffset,
    rows[0].file_bytes.byteOffset + rows[0].file_bytes.byteLength,
  );
  return new NextResponse(ab as ArrayBuffer, {
    status: 200,
    headers: {
      'Content-Type': rows[0].mime_type || 'application/octet-stream',
      'Content-Length': String(rows[0].size_bytes),
      'Content-Disposition': `inline; filename="${rows[0].file_name.replace(/"/g, '')}"; filename*=UTF-8''${encName}`,
      // Force a fresh fetch — bytea blobs aren't cache-friendly across
      // browser tabs anyway, and stale caches lead to "why am I seeing
      // last week's file?" complaints.
      'Cache-Control': 'private, no-store',
    },
  });
}
