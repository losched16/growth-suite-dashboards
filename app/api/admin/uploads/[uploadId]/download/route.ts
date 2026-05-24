// Operator-side download for any parent upload. Auth is the operator
// session (proxy guard already redirects non-authenticated users to
// /login). No family-id check — operator sees everything for their org.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';

type Params = Promise<{ uploadId: string }>;

export async function GET(_request: NextRequest, { params }: { params: Params }) {
  const { uploadId } = await params;
  const { rows } = await query<{
    original_filename: string;
    mime_type: string;
    contents: Buffer;
  }>(
    `SELECT original_filename, mime_type, contents FROM parent_uploads WHERE id = $1`,
    [uploadId],
  );
  if (rows.length === 0) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const row = rows[0];
  const filename = row.original_filename.replace(/[^\w. -]/g, '_');
  return new NextResponse(new Uint8Array(row.contents), {
    status: 200,
    headers: {
      'Content-Type': row.mime_type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
