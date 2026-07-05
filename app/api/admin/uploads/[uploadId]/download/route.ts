// Operator-side download for any parent upload. Auth is the operator
// session (proxy guard already redirects non-authenticated users to
// /login). No family-id check — operator sees everything for their org.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { authorizeOperatorOrSchool } from '@/lib/auth/dual';

type Params = Promise<{ uploadId: string }>;

export async function GET(_request: NextRequest, { params }: { params: Params }) {
  const { uploadId } = await params;
  // AUTH (security remediation 1.2): resolve the owning school from the upload
  // and require an operator OR that school's session. Parent uploads are
  // student PII (medical forms, IDs), so this must not be publicly reachable.
  const _up = await query<{ school_id: string }>(
    `SELECT school_id FROM parent_uploads WHERE id = const { uploadId } = await params;`, [uploadId]);
  if (_up.rows.length === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const _auth = await authorizeOperatorOrSchool(_up.rows[0].school_id);
  if (!_auth.ok) return _auth.response;
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
