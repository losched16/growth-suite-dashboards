// PATCH  /api/admin/schools/{schoolId}/shared-documents/{docId}  { is_active }
// DELETE /api/admin/schools/{schoolId}/shared-documents/{docId}
// GET    /api/admin/schools/{schoolId}/shared-documents/{docId}   (download)

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { query } from '@/lib/db';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string; docId: string }>;

async function authorize(schoolId: string): Promise<boolean> {
  const ck = await cookies();
  if (verifySessionToken(ck.get(SESSION_COOKIE)?.value)) return true;
  const ss = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  return !!ss && ss.school_id === schoolId;
}

export async function PATCH(request: NextRequest, { params }: { params: Params }) {
  const { schoolId, docId } = await params;
  if (!(await authorize(schoolId))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  let body: { is_active?: unknown } = {};
  try { body = await request.json(); } catch { /* fall through */ }
  if (typeof body.is_active !== 'boolean') {
    return NextResponse.json({ error: 'missing_is_active' }, { status: 400 });
  }
  const res = await query(
    `UPDATE school_shared_documents SET is_active = $3 WHERE id = $1 AND school_id = $2`,
    [docId, schoolId, body.is_active],
  );
  if ((res.rowCount ?? 0) === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: NextRequest, { params }: { params: Params }) {
  const { schoolId, docId } = await params;
  if (!(await authorize(schoolId))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const res = await query(
    `DELETE FROM school_shared_documents WHERE id = $1 AND school_id = $2`,
    [docId, schoolId],
  );
  if ((res.rowCount ?? 0) === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function GET(_request: NextRequest, { params }: { params: Params }) {
  const { schoolId, docId } = await params;
  if (!(await authorize(schoolId))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { rows } = await query<{ file_name: string; mime_type: string; file_bytes: Buffer }>(
    `SELECT file_name, mime_type, file_bytes FROM school_shared_documents WHERE id = $1 AND school_id = $2`,
    [docId, schoolId],
  );
  if (rows.length === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const r = rows[0];
  const filename = r.file_name.replace(/[^\w. -]/g, '_');
  return new NextResponse(new Uint8Array(r.file_bytes), {
    status: 200,
    headers: {
      'Content-Type': r.mime_type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
