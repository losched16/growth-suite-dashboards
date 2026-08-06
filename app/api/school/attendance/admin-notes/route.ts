// Set / clear the OFFICE-ONLY note on a student's daily attendance row
// (migration 096). Edited from the Attendance dashboard; never shown to
// parents — the parent portal reads status/times/event notes only.
// Unlike custom_status, real check-in/out events do NOT clear the note.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return new NextResponse('unauthorized', { status: 401 });

  const fd = await request.formData();
  const studentId = String(fd.get('student_id') ?? '').trim();
  const notes = String(fd.get('notes') ?? '').trim(); // '' = clear
  const dateRaw = String(fd.get('date') ?? '').trim(); // optional YYYY-MM-DD (history drawer)
  if (!studentId) return new NextResponse('student_id required', { status: 400 });
  if (dateRaw && !/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
    return new NextResponse('bad date', { status: 400 });
  }
  if (notes.length > 2000) return new NextResponse('note too long (2000 max)', { status: 400 });

  const { rows } = await query<{ id: string; school_id: string }>(
    `SELECT id, school_id FROM students WHERE id = $1`,
    [studentId],
  );
  if (rows.length === 0) return new NextResponse('student not found', { status: 404 });
  if (rows[0].school_id !== session.school_id) return new NextResponse('forbidden', { status: 403 });

  // Upsert the day's row. status 'not_yet' only seeds a BRAND-NEW row
  // (no events yet); existing rows keep their event-derived status —
  // the ON CONFLICT branch touches only the note columns.
  await query(
    `INSERT INTO daily_attendance (
       school_id, student_id, date, status,
       admin_notes, admin_notes_updated_at, updated_at
     ) VALUES (
       $1, $2, COALESCE($4::date, (now() AT TIME ZONE 'America/Phoenix')::date), 'not_yet',
       $3, CASE WHEN $3::text IS NULL THEN NULL ELSE now() END, now()
     )
     ON CONFLICT (school_id, student_id, date) DO UPDATE SET
       admin_notes            = EXCLUDED.admin_notes,
       admin_notes_updated_at = EXCLUDED.admin_notes_updated_at,
       updated_at             = now()`,
    [session.school_id, studentId, notes || null, dateRaw || null],
  );

  return NextResponse.json({ ok: true });
}
