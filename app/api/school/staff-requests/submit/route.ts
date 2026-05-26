// POST /api/school/staff-requests/submit
//
// Teacher submits one of the staff-facing forms (Labor / Incident /
// Supplies). Identified by the school-session user_email — no parent
// or family attached. Status starts at 'pending' so it appears in
// Lexi's inbox. Notification email fires to every notify_emails entry
// on the form definition.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { query } from '@/lib/db';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let fd: FormData;
  try {
    fd = await request.formData();
  } catch {
    return NextResponse.json({ error: 'invalid_form_data' }, { status: 400 });
  }

  const formDefId = String(fd.get('form_definition_id') ?? '').trim();
  if (!formDefId) {
    return NextResponse.json({ error: 'missing_form_definition_id' }, { status: 400 });
  }
  // Pulled from the hidden field we set on the renderer. Used so we can
  // redirect the teacher back to the classroom hub they came from.
  const returnTo = String(fd.get('return_to') ?? '').trim();

  // Load the form definition. MUST be audience='staff' to use this
  // endpoint — parent forms go through /api/portal-forms/submit.
  const { rows: defRows } = await query<{
    id: string; slug: string; display_name: string; school_id: string;
    audience: string; notify_emails: string[] | null;
    field_schema: Array<Record<string, unknown>>;
    confirmation_message: string | null;
  }>(
    `SELECT id, slug, display_name, school_id, audience, notify_emails,
            field_schema, confirmation_message
       FROM portal_form_definitions
      WHERE id = $1 AND school_id = $2 AND is_active = true`,
    [formDefId, session.school_id],
  );
  if (defRows.length === 0) {
    return NextResponse.json({ error: 'form_not_found' }, { status: 404 });
  }
  const def = defRows[0];
  if (def.audience !== 'staff') {
    return NextResponse.json({ error: 'not_a_staff_form' }, { status: 400 });
  }

  // Build the responses JSON from the schema keys we know about.
  const responses: Record<string, unknown> = {};
  const blocks = Array.isArray(def.field_schema) ? def.field_schema : [];
  for (const block of blocks) {
    const key = String(block.key ?? '').trim();
    if (!key) continue;
    const type = String(block.type ?? '');
    if (type === 'multi_checkbox') {
      const values = fd.getAll(key).map((v) => String(v));
      if (values.length > 0) responses[key] = values;
    } else if (type === 'checkbox') {
      responses[key] = fd.has(key);
    } else if (type !== 'file_upload') {
      const v = fd.get(key);
      if (v != null) responses[key] = typeof v === 'string' ? v : String(v);
    }
  }

  // Default the assigned_to to the first notify_emails entry (Lexi).
  const assignedTo = (def.notify_emails && def.notify_emails.length > 0)
    ? def.notify_emails[0]
    : null;

  const ins = await query<{ id: string }>(
    `INSERT INTO portal_form_submissions
       (school_id, form_definition_id, family_id, parent_id, student_id,
        responses, status, submitted_at, is_test,
        submitter_email, assigned_to_email, resolved_status)
     VALUES ($1, $2, NULL, NULL, NULL,
             $3::jsonb, 'submitted', now(), false,
             $4, $5, 'pending')
     RETURNING id`,
    [session.school_id, formDefId, JSON.stringify(responses), session.user_email, assignedTo],
  );
  const submissionId = ins.rows[0].id;

  // Fire the notification email to Lexi (fire-and-forget). Renders via
  // the shared notification-email helper — same body production uses
  // for any office notification.
  if (def.notify_emails && def.notify_emails.length > 0) {
    import('@/lib/forms/notification-email').then(({ renderNotificationEmail }) =>
      import('@/lib/email').then(({ sendBrandedEmail }) => {
        const { subject, html, text } = renderNotificationEmail({
          formDisplayName: def.display_name,
          schoolName: 'Desert Garden Montessori', // could resolve via schools table; cheap shortcut
          submissionId,
          familyLabel: `STAFF REQUEST · ${session.user_email}`,
          studentLabel: null,
          parentEmail: null,
          parentPhone: null,
          responses,
        });
        return Promise.allSettled(
          (def.notify_emails ?? []).map((to) =>
            sendBrandedEmail({ to, schoolId: session.school_id, subject, html, text }),
          ),
        );
      }),
    ).catch((e) => console.error('[staff-requests/submit] notify failed:', e));
  }

  // Where to land. If we have a return_to from the teacher's hub,
  // honor it (validated). Otherwise default to a "my requests"
  // dashboard slug.
  const safeReturn = returnTo && /^\/school\/[A-Za-z0-9_-]+\//.test(returnTo)
    ? returnTo
    : `/school/${session.ghl_location_id}/staff-requests/mine?submitted=${encodeURIComponent(def.slug)}`;

  return NextResponse.json({
    id: submissionId,
    slug: def.slug,
    redirect_to: safeReturn,
    confirmation_message: def.confirmation_message,
  });
}
