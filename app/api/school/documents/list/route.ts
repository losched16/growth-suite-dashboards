// GET /api/school/documents/list?student_id=<uuid>
//
// Returns the documents attached to a single student. Used by the
// inline cell on the Student Roster row so the operator can see a
// student's docs without leaving the roster.
//
// School-session-authed; results are scoped to the session's school
// even though the URL passes a student_id (defense in depth — a
// crafted student_id from another school returns 404).

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface DocRow {
  id: string;
  title: string;
  category: string | null;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  uploaded_at: string;
  uploaded_by: string | null;
  expires_at: string | null;
  visible_to_teacher: boolean;
  visible_to_parent: boolean;
}

export async function GET(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const studentId = (request.nextUrl.searchParams.get('student_id') ?? '').trim();
  if (!studentId) {
    return NextResponse.json({ ok: false, error: 'student_id required' }, { status: 400 });
  }

  // school_id check is applied in the WHERE, so a cross-school
  // student_id returns an empty list (not a leak).
  const { rows } = await query<DocRow>(
    `SELECT id, title, category, file_name, mime_type, size_bytes,
            uploaded_at, uploaded_by, expires_at,
            visible_to_teacher, visible_to_parent
       FROM student_documents
      WHERE school_id = $1 AND student_id = $2
      ORDER BY uploaded_at DESC`,
    [session.school_id, studentId],
  );

  return NextResponse.json({ ok: true, documents: rows });
}
