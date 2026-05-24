// POST /api/school/documents/{id}/delete
//
// Soft confirm via POST form so it's safe behind a button. School-
// session-authed; the WHERE clause scopes to school_id so cross-school
// deletes can't happen.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ id: string }>;

export async function POST(_request: NextRequest, { params }: { params: Params }) {
  const { id } = await params;
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const result = await query(
    `DELETE FROM student_documents WHERE id = $1 AND school_id = $2`,
    [id, session.school_id],
  );
  if (result.rowCount === 0) {
    return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
