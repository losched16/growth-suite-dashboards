// Set / clear an office-defined custom attendance status ("Field Trip",
// "Sick" …) on a student for TODAY. The label is a display override on
// daily_attendance; the event-derived status keeps computing underneath
// and any real check-in/out AFTER this clears the label (see migration
// 091 trigger). Valid keys come from the school's self-managed category
// list (settings.attendance_custom_statuses).

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { query } from '@/lib/db';
import { readCustomStatuses } from '@/lib/attendance/custom-statuses';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return new NextResponse('unauthorized', { status: 401 });

  const fd = await request.formData();
  const studentId = String(fd.get('student_id') ?? '').trim();
  const statusKey = String(fd.get('status') ?? '').trim(); // '' = clear
  if (!studentId) return new NextResponse('student_id required', { status: 400 });

  const { rows } = await query<{ id: string; school_id: string }>(
    `SELECT id, school_id FROM students WHERE id = $1`,
    [studentId],
  );
  if (rows.length === 0) return new NextResponse('student not found', { status: 404 });
  if (rows[0].school_id !== session.school_id) return new NextResponse('forbidden', { status: 403 });

  if (statusKey) {
    const list = await readCustomStatuses(session.school_id);
    if (!list.some((s) => s.key === statusKey)) {
      return new NextResponse('unknown status category', { status: 400 });
    }
  }

  // Upsert today's row. status 'not_yet' only seeds a BRAND-NEW row (a
  // kid with no events yet); existing rows keep their event-derived
  // status — the ON CONFLICT branch doesn't touch it.
  await query(
    `INSERT INTO daily_attendance (
       school_id, student_id, date, status,
       custom_status, custom_status_set_at, updated_at
     ) VALUES (
       $1, $2, (now() AT TIME ZONE 'America/Phoenix')::date, 'not_yet',
       $3, CASE WHEN $3::text IS NULL THEN NULL ELSE now() END, now()
     )
     ON CONFLICT (school_id, student_id, date) DO UPDATE SET
       custom_status        = EXCLUDED.custom_status,
       custom_status_set_at = EXCLUDED.custom_status_set_at,
       updated_at           = now()`,
    [session.school_id, studentId, statusKey || null],
  );

  return NextResponse.json({ ok: true });
}
