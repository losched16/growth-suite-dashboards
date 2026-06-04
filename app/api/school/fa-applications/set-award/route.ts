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

const ALLOWED_STATUSES = new Set(['under_review', 'decided', 'withdrawn', 'declined']);

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

    const now = new Date().toISOString();
    const decidedAt = status === 'decided' ? now : null;
    const reviewStartedAt = status === 'under_review' ? now : null;
    await q(
      `UPDATE fa_applications
       SET recommended_award = $1,
           decision_note = $2,
           status = $3,
           decided_at = COALESCE($4::timestamptz, decided_at),
           decided_by = COALESCE($5, decided_by),
           review_started_at = COALESCE($6::timestamptz, review_started_at),
           review_started_by = COALESCE($7, review_started_by)
       WHERE id = $8`,
      [
        anyAwardSet ? totalAward : null,
        familyNote,
        status,
        decidedAt,
        status === 'decided' ? session.user_email : null,
        reviewStartedAt,
        status === 'under_review' ? session.user_email : null,
        applicationId,
      ],
    );
  });

  // Fire-and-forget parent notification on decision. We look up the
  // family's primary parent + the school name, then build a friendly
  // email with the decision summary + a link to view the full letter
  // in the parent portal.
  if (status === 'decided') {
    Promise.resolve().then(async () => {
      try {
        const { rows: app } = await query<{
          family_id: string; academic_year: string; recommended_award: string | null; decision_note: string | null;
          school_name: string; parent_email: string | null; parent_first: string | null;
        }>(
          `SELECT a.family_id, a.academic_year, a.recommended_award::text, a.decision_note,
                  sc.name AS school_name,
                  (SELECT email FROM parents WHERE family_id = a.family_id AND is_primary = true AND status='active' LIMIT 1) AS parent_email,
                  (SELECT first_name FROM parents WHERE family_id = a.family_id AND is_primary = true AND status='active' LIMIT 1) AS parent_first
             FROM fa_applications a
             JOIN schools sc ON sc.id = a.school_id
            WHERE a.id = $1`,
          [applicationId],
        );
        if (app.length === 0) return;
        const parentEmail = app[0].parent_email;
        if (!parentEmail) return;                  // narrowed for downstream use
        const a = app[0];
        const award = a.recommended_award !== null ? `$${Number(a.recommended_award).toLocaleString()}` : 'No award';
        const { sendBrandedEmail } = await import('@/lib/email');
        await sendBrandedEmail({
          to: parentEmail,
          schoolId: session.school_id,
          subject: `Your ${a.academic_year} Financial Aid decision from ${a.school_name}`,
          html: `<p>Hi ${a.parent_first ?? 'there'},</p>
<p>The financial aid committee at <strong>${a.school_name}</strong> has reached a decision on your application for the <strong>${a.academic_year}</strong> school year.</p>
<p><strong>Award:</strong> ${award}</p>
${a.decision_note ? `<p><strong>Note from the school:</strong></p><blockquote>${a.decision_note.replace(/[<>]/g, '')}</blockquote>` : ''}
<p>Sign in to your parent portal to view the full decision letter and download a PDF for your records.</p>
<p>Warmly,<br/>${a.school_name}</p>`,
          text: `Hi ${a.parent_first ?? 'there'},\n\nThe financial aid committee at ${a.school_name} has reached a decision on your application for the ${a.academic_year} school year.\n\nAward: ${award}\n\n${a.decision_note ? 'Note from the school: ' + a.decision_note + '\n\n' : ''}Sign in to your parent portal for the full letter.\n\nWarmly,\n${a.school_name}`,
        });
      } catch (e) {
        console.error('[fa/set-award] parent notify failed:', e);
      }
    });
  }

  return NextResponse.json({ ok: true });
}
