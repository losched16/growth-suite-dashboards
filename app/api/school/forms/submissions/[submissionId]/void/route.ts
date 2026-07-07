// POST /api/school/forms/submissions/{submissionId}/void
//
// Void a submission so the family can redo the form. The row is kept
// (status='voided' + who/when/why) for the audit trail, but every
// consumer — the parent's form lock, completion trackers, counts,
// co-sign links — ignores voided rows, so the family immediately gets
// a fresh, editable form.
//
// Paid / pending-payment submissions can't be voided here: they have an
// invoice attached, and unwinding money is an operator decision.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ submissionId: string }>;

function back(request: NextRequest, returnTo: string | null, q: { msg?: string; err?: string }) {
  const url = request.nextUrl.clone();
  url.pathname = returnTo && /^\/school\/[A-Za-z0-9_-]+\//.test(returnTo) ? returnTo : '/school';
  url.search = '';
  if (q.msg) url.searchParams.set('msg', q.msg);
  if (q.err) url.searchParams.set('err', q.err);
  return NextResponse.redirect(url, 303);
}

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { submissionId } = await params;
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const fd = await request.formData();
  const reason = String(fd.get('reason') ?? '').trim() || null;
  const returnTo = String(fd.get('return_to') ?? '').trim() || null;

  const { rows } = await query<{ id: string }>(
    `UPDATE portal_form_submissions
        SET status = 'voided',
            voided_at = now(),
            voided_by_admin_email = $3,
            voided_reason = $4
      WHERE id = $1 AND school_id = $2
        AND status IN ('submitted', 'legacy_imported')
      RETURNING id`,
    [submissionId, session.school_id, session.user_email ?? 'school-admin', reason],
  );
  if (rows.length === 0) {
    const { rows: chk } = await query<{ status: string }>(
      `SELECT status FROM portal_form_submissions WHERE id = $1 AND school_id = $2`,
      [submissionId, session.school_id],
    );
    const status = chk[0]?.status;
    const err = !status
      ? 'Submission not found.'
      : status === 'voided'
        ? 'Already voided.'
        : `Can't void a ${status.replace(/_/g, ' ')} submission here — it has payment attached; contact support.`;
    return back(request, returnTo, { err });
  }

  return back(request, returnTo, { msg: 'Submission voided — the family can now fill the form out again.' });
}
