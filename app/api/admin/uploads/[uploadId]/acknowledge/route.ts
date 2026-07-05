// Mark a parent upload as "acknowledged by the school". Toggle: if
// already acknowledged, leave alone. The parent sees a green badge on
// their /forms page when this is set.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { authorizeOperatorOrSchool } from '@/lib/auth/dual';

type Params = Promise<{ uploadId: string }>;

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { uploadId } = await params;
  // AUTH (security remediation 1.2): resolve the owning school from the upload
  // and require an operator OR that school's session. Parent uploads are
  // student PII (medical forms, IDs), so this must not be publicly reachable.
  const _up = await query<{ school_id: string }>(
    `SELECT school_id FROM parent_uploads WHERE id = const { uploadId } = await params;`, [uploadId]);
  if (_up.rows.length === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const _auth = await authorizeOperatorOrSchool(_up.rows[0].school_id);
  if (!_auth.ok) return _auth.response;
  const { rows } = await query<{ school_id: string }>(
    `UPDATE parent_uploads
     SET acknowledged_at = COALESCE(acknowledged_at, now())
     WHERE id = $1
     RETURNING school_id`,
    [uploadId],
  );
  const url = request.nextUrl.clone();
  if (rows.length > 0) {
    url.pathname = `/admin/${rows[0].school_id}/uploads`;
    url.search = '';
    url.searchParams.set('msg', 'Marked as acknowledged.');
  } else {
    url.pathname = '/admin';
    url.search = '';
    url.searchParams.set('err', 'Upload not found.');
  }
  return NextResponse.redirect(url, 303);
}
