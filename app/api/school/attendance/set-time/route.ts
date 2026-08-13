// Admin time correction (migration 100): set the ACTUAL check-in or
// check-out time for a student's day. Voids that day's existing events
// of the same type (audit kept: voided_at + who) and inserts one
// corrected manual_override event at the chosen time — the recompute
// trigger then rewrites daily_attendance from the surviving events, so
// every dashboard/kiosk/portal surface shows the corrected time.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { query, withTransaction } from '@/lib/db';

export const dynamic = 'force-dynamic';

const TZ = 'America/Phoenix';

export async function POST(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return new NextResponse('unauthorized', { status: 401 });

  const fd = await request.formData();
  const studentId = String(fd.get('student_id') ?? '').trim();
  const eventType = String(fd.get('event_type') ?? '').trim();
  const time = String(fd.get('time') ?? '').trim();          // 'HH:MM' Phoenix local
  const dateRaw = String(fd.get('date') ?? '').trim();        // optional YYYY-MM-DD, default today
  const customNote = String(fd.get('notes') ?? '').trim();    // optional admin note
  if (!studentId) return new NextResponse('student_id required', { status: 400 });
  if (eventType !== 'check_in' && eventType !== 'check_out') {
    return new NextResponse('event_type must be check_in or check_out', { status: 400 });
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return new NextResponse('time must be HH:MM (24h)', { status: 400 });
  if (dateRaw && !/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) return new NextResponse('bad date', { status: 400 });

  const { rows } = await query<{ id: string; school_id: string }>(
    `SELECT id, school_id FROM students WHERE id = $1`, [studentId]);
  if (rows.length === 0) return new NextResponse('student not found', { status: 404 });
  if (rows[0].school_id !== session.school_id) return new NextResponse('forbidden', { status: 403 });

  const result = await withTransaction(async (q) => {
    // The corrected moment, interpreted in Phoenix local time.
    const { rows: ts } = await q<{ at: string; day: string }>(
      `SELECT ((COALESCE($1::date, (now() AT TIME ZONE '${TZ}')::date))::text || ' ' || $2)::timestamp
                AT TIME ZONE '${TZ}' AS at,
              COALESCE($1::date, (now() AT TIME ZONE '${TZ}')::date)::text AS day`,
      [dateRaw || null, time],
    );
    const performedAt = ts[0].at;
    const day = ts[0].day;

    // Void that day's live events of this type (audit stays).
    const voided = await q(
      `UPDATE attendance_events
          SET voided_at = now(), voided_by_admin_email = $4
        WHERE school_id = $1 AND student_id = $2 AND event_type = $3
          AND voided_at IS NULL
          AND (performed_at AT TIME ZONE '${TZ}')::date = $5::date`,
      [session.school_id, studentId, eventType, session.user_email, day],
    );

    // Insert the corrected event.
    await q(
      `INSERT INTO attendance_events (
         school_id, student_id, event_type, performed_by_admin_email,
         performed_at, notes, ip_address, user_agent
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [session.school_id, studentId, eventType, session.user_email,
       performedAt,
       customNote
         ? `${customNote} — admin set ${eventType === 'check_in' ? 'check-in' : 'check-out'} time to ${time}${(voided.rowCount ?? 0) > 0 ? `, replaced ${voided.rowCount} prior event(s)` : ''}`
         : `Admin set ${eventType === 'check_in' ? 'check-in' : 'check-out'} time to ${time} (${day}) — replaced ${voided.rowCount ?? 0} prior event(s)`,
       request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
       request.headers.get('user-agent')],
    );
    return { voided: voided.rowCount ?? 0 };
  });

  return NextResponse.json({ ok: true, replaced: result.voided });
}
