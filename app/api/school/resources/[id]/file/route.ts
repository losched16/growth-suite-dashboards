// GET /api/school/resources/{id}/file
//
// Operator-side download / preview. School-session auth; only returns
// rows scoped to the operator's school. Used by the admin list to
// preview a doc before publishing (and to recover the original file
// if the school needs to share it outside the portal).
//
// Inline by default; pass ?download=1 to force a Save As prompt.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ id: string }>;

export async function GET(request: NextRequest, { params }: { params: Params }) {
  const { id } = await params;
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { rows } = await query<{
    original_filename: string;
    mime_type: string;
    contents: Buffer;
  }>(
    `SELECT original_filename, mime_type, contents
       FROM school_documents
      WHERE id = $1 AND school_id = $2`,
    [id, session.school_id],
  );
  if (rows.length === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const row = rows[0];

  const url = new URL(request.url);
  const forceDownload = url.searchParams.get('download') === '1';
  const safeName = row.original_filename.replace(/[^\w. -]/g, '_');

  return new NextResponse(new Uint8Array(row.contents), {
    status: 200,
    headers: {
      'Content-Type': row.mime_type || 'application/octet-stream',
      'Content-Disposition': `${forceDownload ? 'attachment' : 'inline'}; filename="${safeName}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
