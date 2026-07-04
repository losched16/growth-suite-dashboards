// GET /api/admin/onboarding/doc/[docId] — operator downloads a submitted
// intake document (roster CSV, logo, etc.). Operator-only. Streams the bytea
// with the stored MIME + filename. Roster files contain student PII, so this
// path is authenticated (never a public URL).

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { query } from '@/lib/db';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ docId: string }>;

export async function GET(_request: NextRequest, { params }: { params: Params }) {
  const ck = await cookies();
  if (!verifySessionToken(ck.get(SESSION_COOKIE)?.value)) {
    return new NextResponse('unauthorized', { status: 401 });
  }
  const { docId } = await params;

  const { rows } = await query<{ original_filename: string; mime_type: string; contents: Buffer }>(
    `SELECT original_filename, mime_type, contents FROM onboarding_documents WHERE id = $1`,
    [docId],
  );
  const doc = rows[0];
  if (!doc) return new NextResponse('not found', { status: 404 });

  return new NextResponse(new Uint8Array(doc.contents), {
    status: 200,
    headers: {
      'Content-Type': doc.mime_type || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${doc.original_filename.replace(/"/g, '')}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
