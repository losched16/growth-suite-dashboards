// GET /api/school/website-documents/{id}/file — bytes for the manager's
// Preview link. Separate from the public route because an operator needs to
// check an UNPUBLISHED document before letting it onto the website, and the
// public route deliberately refuses those.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ id: string }>;

function safeName(name: string): string {
  const clean = name.replace(/[\\/\u0000-\u001f"]/g, '').trim();
  return clean.slice(0, 120) || 'document';
}

export async function GET(_request: NextRequest, { params }: { params: Params }) {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id } = await params;
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) {
    return NextResponse.json({ error: 'bad_id' }, { status: 400 });
  }

  const { rows } = await query<{
    contents: Buffer; mime_type: string; original_filename: string;
  }>(
    `SELECT contents, mime_type, original_filename
       FROM website_documents
      WHERE id = $1 AND school_id = $2`,
    [id, session.school_id],
  );
  if (rows.length === 0 || !rows[0].contents) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(rows[0].contents), {
    status: 200,
    headers: {
      'Content-Type': rows[0].mime_type || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${safeName(rows[0].original_filename)}"`,
      // A draft can be replaced under the same id's eyes; don't let a browser
      // hold on to it the way the public route's immutable bytes allow.
      'Cache-Control': 'private, no-store',
    },
  });
}
