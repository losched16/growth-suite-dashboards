// Stream a single FA application file. Auth: school session must be for
// the same school the file belongs to. Bytea-stored, served inline so
// the browser previews PDFs / images directly.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface FileRow {
  display_name: string;
  mime_type: string;
  contents: Buffer;
  school_id: string;
}

export async function GET(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return new NextResponse('unauthorized', { status: 401 });

  const id = request.nextUrl.searchParams.get('id') ?? '';
  if (!id) return new NextResponse('id required', { status: 400 });

  const { rows } = await query<FileRow>(
    `SELECT display_name, mime_type, contents, school_id
     FROM fa_application_files WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) return new NextResponse('not found', { status: 404 });
  const f = rows[0];
  if (f.school_id !== session.school_id) return new NextResponse('forbidden', { status: 403 });

  const body = Buffer.isBuffer(f.contents) ? f.contents : Buffer.from(f.contents);
  return new NextResponse(new Uint8Array(body), {
    status: 200,
    headers: {
      'Content-Type': f.mime_type || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${f.display_name.replace(/"/g, '')}"`,
      'Cache-Control': 'private, max-age=60',
    },
  });
}
