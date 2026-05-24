// Mark a parent upload as "acknowledged by the school". Toggle: if
// already acknowledged, leave alone. The parent sees a green badge on
// their /forms page when this is set.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';

type Params = Promise<{ uploadId: string }>;

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { uploadId } = await params;
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
