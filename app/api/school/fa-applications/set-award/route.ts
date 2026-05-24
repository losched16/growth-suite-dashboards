// Update FA decisions. Now writes per-student awards into
// fa_application_students and rolls up the total onto
// fa_applications.recommended_award for backwards-compat (the parent
// portal aggregates from the child table directly).
//
// Body (multipart): application_id, status, decision_note,
//   award_<student_id>=<amount>  (one per student)
//   note_<student_id>=<text>     (per-student override note)

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { query, withTransaction } from '@/lib/db';

export const dynamic = 'force-dynamic';

const ALLOWED_STATUSES = new Set(['reviewing', 'decided', 'withdrawn']);

export async function POST(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return new NextResponse('unauthorized', { status: 401 });

  const fd = await request.formData();
  const applicationId = String(fd.get('application_id') ?? '').trim();
  if (!applicationId) return new NextResponse('application_id required', { status: 400 });
  const status = String(fd.get('status') ?? '').trim();
  if (!ALLOWED_STATUSES.has(status)) {
    return new NextResponse(`invalid status (allowed: ${[...ALLOWED_STATUSES].join(', ')})`, { status: 400 });
  }
  const familyNote = String(fd.get('decision_note') ?? '').trim() || null;

  // Verify the application belongs to this school
  const { rows: appRows } = await query<{ id: string; school_id: string }>(
    `SELECT id, school_id FROM fa_applications WHERE id = $1`,
    [applicationId],
  );
  if (appRows.length === 0) return new NextResponse('not found', { status: 404 });
  if (appRows[0].school_id !== session.school_id) return new NextResponse('forbidden', { status: 403 });

  // Load child rows so we know which student_ids belong to this app
  const { rows: childRows } = await query<{ id: string; student_id: string }>(
    `SELECT id, student_id FROM fa_application_students WHERE application_id = $1`,
    [applicationId],
  );

  await withTransaction(async (q) => {
    let totalAward = 0;
    let anyAwardSet = false;
    for (const c of childRows) {
      const rawAmt = String(fd.get(`award_${c.id}`) ?? '').trim();
      const amount = rawAmt === '' ? null : Number(rawAmt);
      if (rawAmt !== '' && (!Number.isFinite(amount as number) || (amount as number) < 0)) {
        throw new Error(`invalid award for student row ${c.id}`);
      }
      const note = String(fd.get(`note_${c.id}`) ?? '').trim() || null;
      if (amount !== null) {
        totalAward += amount;
        anyAwardSet = true;
      }
      await q(
        `UPDATE fa_application_students
         SET recommended_award = $1, award_note = $2
         WHERE id = $3`,
        [amount, note, c.id],
      );
    }

    const decidedAt = status === 'decided' ? new Date().toISOString() : null;
    await q(
      `UPDATE fa_applications
       SET recommended_award = $1,
           decision_note = $2,
           status = $3,
           decided_at = COALESCE($4::timestamptz, decided_at),
           decided_by = COALESCE($5, decided_by)
       WHERE id = $6`,
      [
        anyAwardSet ? totalAward : null,
        familyNote,
        status,
        decidedAt,
        status === 'decided' ? session.user_email : null,
        applicationId,
      ],
    );
  });

  return NextResponse.json({ ok: true });
}
