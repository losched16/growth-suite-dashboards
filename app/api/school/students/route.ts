// GET /api/school/students
//
// Returns the searchable student list for the session's school —
// powers the StudentIncidentPicker on the SST Accident/Incident form.
// Returns just the fields the picker needs (no contact info; we do
// the parent lookup server-side on submit, so this list never leaks
// parent emails through a wide-open list endpoint).
//
// Auth: requires a valid school session cookie. The school is
// derived from the session — no school_id param accepted, so a
// teacher viewing School A can't poke at School B's roster.

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { query } from '@/lib/db';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface StudentLite {
  id: string;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  homeroom: string | null;
}

export async function GET() {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { rows } = await query<StudentLite>(
    `SELECT id, first_name, last_name, preferred_name,
            COALESCE(metadata->>'homeroom', metadata->>'classroom_name') AS homeroom
       FROM students
      WHERE school_id = $1 AND status = 'active'
      ORDER BY last_name, first_name`,
    [session.school_id],
  );

  return NextResponse.json({ students: rows });
}
