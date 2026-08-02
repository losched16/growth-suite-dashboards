// GET /api/school/documents/{id}/download
//
// Streams a student document's bytea back to the browser with proper
// content-disposition so the file downloads with its original name.
// Auth: school session for the doc's school OR a valid embed token —
// downloads open in a NEW TAB from inside the GHL iframe, where the
// (partitioned) session cookie doesn't follow, so session-only auth
// made every "Open" click say unauthorized.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { checkEmbedToken } from '@/lib/auth/embed';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ id: string }>;

export async function GET(request: NextRequest, { params }: { params: Params }) {
  const { id } = await params;

  const { rows } = await query<{
    school_id: string;
    ghl_location_id: string | null;
    file_name: string;
    mime_type: string;
    file_bytes: Buffer;
    size_bytes: number;
  }>(
    `SELECT d.school_id, s.ghl_location_id,
            d.file_name, d.mime_type, d.file_bytes, d.size_bytes
       FROM student_documents d
       JOIN schools s ON s.id = d.school_id
      WHERE d.id = $1 AND d.is_complete = true`,
    [id],
  );
  if (rows.length === 0 || !rows[0].file_bytes) {
    return new NextResponse('not found', { status: 404 });
  }

  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  const sessionOk = !!session && session.school_id === rows[0].school_id;
  const embedToken = request.nextUrl.searchParams.get('embed_token');
  const embedOk = !!embedToken && !!rows[0].ghl_location_id
    && checkEmbedToken(rows[0].ghl_location_id, embedToken);
  if (!sessionOk && !embedOk) return new NextResponse('unauthorized', { status: 401 });

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
