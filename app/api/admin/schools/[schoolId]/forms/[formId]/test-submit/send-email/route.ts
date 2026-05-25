// POST /api/admin/schools/{schoolId}/forms/{formId}/test-submit/send-email
//
// Fires a REAL email to a staff-chosen address using the same body
// renderer production uses for office notifications. Lets staff
// verify exactly what the office team will see in their inbox before
// rolling a form out.
//
// Body (JSON):
//   submission_id: string  - the test submission to use as source data
//   to_email:      string  - destination (operator's address; must
//                            pass an RFC-ish email regex)
//
// Auth: dual (operator OR matching school session).
//
// We require is_test=true on the source submission so we can never
// accidentally re-fire a real-parent notification.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { authorizeOperatorOrSchool } from '@/lib/auth/dual';
import { renderNotificationEmail } from '@/lib/forms/notification-email';
import { sendBrandedEmail } from '@/lib/email';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string; formId: string }>;

interface Body {
  submission_id?: string;
  to_email?: string;
}

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId, formId } = await params;
  const auth = await authorizeOperatorOrSchool(schoolId);
  if (!auth.ok) return auth.response;

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const submissionId = String(body.submission_id ?? '').trim();
  const toEmail = String(body.to_email ?? '').trim().toLowerCase();
  if (!submissionId) {
    return NextResponse.json({ error: 'missing_submission_id' }, { status: 400 });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail)) {
    return NextResponse.json({ error: 'invalid_email', detail: 'Provide a valid email address.' }, { status: 400 });
  }

  // Resolve the submission + form + school. is_test must be true.
  const { rows } = await query<{
    submission_id: string;
    is_test: boolean;
    responses: Record<string, unknown>;
    form_display_name: string;
    school_name: string;
  }>(
    `SELECT s.id AS submission_id, s.is_test, s.responses,
            d.display_name AS form_display_name,
            sch.name AS school_name
       FROM portal_form_submissions s
       JOIN portal_form_definitions d ON d.id = s.form_definition_id
       JOIN schools sch ON sch.id = s.school_id
      WHERE s.id = $1 AND s.school_id = $2 AND s.form_definition_id = $3`,
    [submissionId, schoolId, formId],
  );
  if (rows.length === 0) {
    return NextResponse.json({ error: 'submission_not_found' }, { status: 404 });
  }
  const sub = rows[0];
  if (!sub.is_test) {
    return NextResponse.json({ error: 'not_a_test_submission', detail: 'For safety, this endpoint only resends test submissions.' }, { status: 400 });
  }

  const { subject, html, text } = renderNotificationEmail({
    formDisplayName: sub.form_display_name,
    schoolName: sub.school_name,
    submissionId: sub.submission_id,
    familyLabel: '(test submission — no real parent)',
    studentLabel: null,
    parentEmail: null,
    parentPhone: null,
    responses: sub.responses,
    isTest: true,
  });

  try {
    await sendBrandedEmail({
      to: toEmail,
      schoolId,
      subject,
      html,
      text,
    });
  } catch (e) {
    return NextResponse.json({
      error: 'send_failed',
      detail: e instanceof Error ? e.message : String(e),
    }, { status: 500 });
  }

  return NextResponse.json({ ok: true, sent_to: toEmail });
}
