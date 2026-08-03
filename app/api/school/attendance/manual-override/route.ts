// Admin-side override. Writes an attendance_events row tagged with
// `performed_by_admin_email` from the school session. Original parent
// events stay intact (append-only) — this row's `notes` field records
// the reason. Allowed event_types: check_in, check_out, absent.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

const ALLOWED = new Set(['check_in', 'check_out', 'absent']);

export async function POST(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return new NextResponse('unauthorized', { status: 401 });

  const fd = await request.formData();
  const studentId = String(fd.get('student_id') ?? '').trim();
  const eventType = String(fd.get('event_type') ?? '').trim();
  const notes = String(fd.get('notes') ?? '').trim() || `Admin manual override by ${session.user_email}`;

  if (!studentId) return new NextResponse('student_id required', { status: 400 });
  if (!ALLOWED.has(eventType)) {
    return new NextResponse(`event_type must be one of: ${[...ALLOWED].join(', ')}`, { status: 400 });
  }

  // Confirm student belongs to this school
  const { rows } = await query<{ id: string; school_id: string }>(
    `SELECT id, school_id FROM students WHERE id = $1`,
    [studentId],
  );
  if (rows.length === 0) return new NextResponse('student not found', { status: 404 });
  if (rows[0].school_id !== session.school_id) return new NextResponse('forbidden', { status: 403 });

  // Idempotence: if the student's LATEST event today is already this
  // same type, don't write another row. Guards against double-taps and
  // the stale-cache re-tap loop (one student collected 13 duplicate
  // admin check-ins on day one). A repeat call still returns ok so the
  // UI flow is unchanged.
  const { rows: lastRows } = await query<{ event_type: string }>(
    `SELECT event_type FROM attendance_events
      WHERE student_id = $1 AND school_id = $2
        AND (performed_at AT TIME ZONE 'America/Phoenix')::date
            = (now() AT TIME ZONE 'America/Phoenix')::date
      ORDER BY performed_at DESC LIMIT 1`,
    [studentId, session.school_id],
  );
  if (lastRows[0]?.event_type === eventType) {
    return NextResponse.json({ ok: true, deduped: true });
  }

  // Write the override event (admin actor, no signature, no parent)
  await query(
    `INSERT INTO attendance_events (
       school_id, student_id, event_type,
       performed_by_admin_email,
       performed_at,
       notes,
       ip_address, user_agent
     ) VALUES ($1, $2, $3, $4, now(), $5, $6, $7)`,
    [
      rows[0].school_id, studentId, eventType,
      session.user_email,
      notes,
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      request.headers.get('user-agent'),
    ],
  );

  return NextResponse.json({ ok: true });
}
