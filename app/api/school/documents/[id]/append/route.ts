// POST /api/school/documents/{id}/append
//
// Chunks 2..N of a chunked document upload (see upload/route.ts — Vercel
// caps request bodies at ~4.5MB, so big files arrive in slices). Appends
// this request's blob to file_bytes on an INCOMPLETE row owned by the
// session's school. `is_last=1` verifies the assembled size matches the
// declared total and flips is_complete=true — on mismatch the row is
// deleted so a broken upload never lingers half-assembled.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const MAX_BYTES = 10 * 1024 * 1024; // matches upload route

type Params = Promise<{ id: string }>;

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { id } = await params;
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const fd = await request.formData();
  const file = fd.get('file');
  const isLast = fd.get('is_last') === '1';
  if (!file || !(file instanceof File) || file.size === 0) {
    return NextResponse.json({ ok: false, error: 'file chunk required' }, { status: 400 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());

  // Append atomically; only incomplete rows of this school are writable.
  const { rows } = await query<{ len: number; size_bytes: number }>(
    `UPDATE student_documents
        SET file_bytes = file_bytes || $3
      WHERE id = $1 AND school_id = $2 AND is_complete = false
      RETURNING octet_length(file_bytes) AS len, size_bytes`,
    [id, session.school_id, bytes],
  );
  if (rows.length === 0) {
    return NextResponse.json({ ok: false, error: 'upload not found (or already complete)' }, { status: 404 });
  }
  const { len, size_bytes } = rows[0];

  if (len > MAX_BYTES || len > size_bytes) {
    await query(`DELETE FROM student_documents WHERE id = $1 AND school_id = $2`, [id, session.school_id]);
    return NextResponse.json({ ok: false, error: 'assembled size exceeded the declared total — upload aborted, please retry' }, { status: 409 });
  }

  if (isLast) {
    if (len !== size_bytes) {
      await query(`DELETE FROM student_documents WHERE id = $1 AND school_id = $2`, [id, session.school_id]);
      return NextResponse.json({
        ok: false,
        error: `assembled ${len} bytes but expected ${size_bytes} — upload aborted, please retry`,
      }, { status: 409 });
    }
    await query(
      `UPDATE student_documents SET is_complete = true WHERE id = $1 AND school_id = $2`,
      [id, session.school_id],
    );
  }

  return NextResponse.json({ ok: true, received: len, complete: isLast });
}
