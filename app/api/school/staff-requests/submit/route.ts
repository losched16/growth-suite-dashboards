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
import { getTeacherIdentity, isValidEmail } from '@/lib/auth/teacher-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Identify the submitting teacher. Prefer the explicit
  // teacher-identity cookie (set via /identify) — it's what the
  // teacher self-selected. Fall back to the school session's
  // user_email when GHL has been wired to pass real user info via
  // the login JWT exchange (today that's a placeholder for auto-
  // minted sessions, so the cookie is the real source of truth).
  const teacher = await getTeacherIdentity();
  const teacherEmail = teacher?.email
    ?? (isValidEmail(session.user_email) && session.user_email !== 'embed@iframe' ? session.user_email : null);
  if (!teacherEmail) {
    return NextResponse.json({
      error: 'identify_first',
      detail: 'Please identify yourself first via /staff-requests so we know who submitted the request.',
    }, { status: 403 });
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
  // Two things accumulate alongside `responses`:
  //   - linkedStudentId: when a student_picker field resolves, we
  //     persist the student id on the submission row so the inbox can
  //     join back to the student/family records.
  //   - linkedFamilyId: same, for family-scoped notifications.
  const responses: Record<string, unknown> = {};
  let linkedStudentId: string | null = null;
  let linkedFamilyId: string | null = null;
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
    } else if (type === 'quantity_grid') {
      // Grid: rows live as separate FormData keys named
      // `<groupKey>__<row_slug>` with quantity-string values. An empty
      // string means "no quantity requested" — skip those so the
      // stored object only contains items the teacher actually wants.
      const rows = Array.isArray(block.rows) ? (block.rows as string[]) : [];
      const grid: Record<string, string> = {};
      for (const row of rows) {
        const rowKey = String(row).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
        const v = fd.get(`${key}__${rowKey}`);
        const s = v == null ? '' : String(v).trim();
        if (s) grid[row] = s; // store with the original label so the inbox can show it directly
      }
      if (Object.keys(grid).length > 0) responses[key] = grid;
    } else if (type === 'student_picker') {
      // Field value is the student id chosen in the searchable picker.
      // We look up the student + their parents server-side so the
      // submission stores a clean, structured contact card the inbox
      // can render without joining at read-time. Parent contact info
      // is *not* exposed by the public /api/school/students endpoint;
      // it only materializes here, after a teacher has explicitly
      // picked a kid as part of submitting an incident report.
      const studentId = String(fd.get(key) ?? '').trim();
      if (!studentId) continue;
      const sRes = await query<{
        id: string; first_name: string; last_name: string; preferred_name: string | null;
        family_id: string | null; homeroom: string | null;
      }>(
        `SELECT id, first_name, last_name, preferred_name, family_id,
                COALESCE(metadata->>'homeroom', metadata->>'classroom_name') AS homeroom
           FROM students WHERE id = $1 AND school_id = $2`,
        [studentId, session.school_id],
      );
      if (sRes.rows.length === 0) continue; // ignore garbage id
      const student = sRes.rows[0];
      let parents: Array<{ id: string; first_name: string; last_name: string; email: string | null; phone: string | null; role: string | null; is_primary: boolean }> = [];
      if (student.family_id) {
        const pRes = await query<{ id: string; first_name: string; last_name: string; email: string | null; phone: string | null; role: string | null; is_primary: boolean }>(
          `SELECT id, first_name, last_name, email, phone, role, is_primary
             FROM parents
            WHERE family_id = $1 AND school_id = $2
            ORDER BY is_primary DESC, last_name, first_name`,
          [student.family_id, session.school_id],
        );
        parents = pRes.rows;
      }
      // Stamp the structured card into responses + remember the ids
      // for the row-level columns.
      responses[key] = {
        _type: 'student_picker',     // marker so the inbox renders this as a contact card
        student_id: student.id,
        family_id: student.family_id,
        name: student.preferred_name?.trim() || student.first_name,
        full_name: `${student.preferred_name?.trim() || student.first_name} ${student.last_name}`.trim(),
        last_name: student.last_name,
        homeroom: student.homeroom,
        parents: parents.map((p) => ({
          id: p.id,
          name: `${p.first_name} ${p.last_name}`.trim(),
          email: p.email,
          phone: p.phone,
          role: p.role,
          is_primary: p.is_primary,
        })),
      };
      linkedStudentId = student.id;
      if (student.family_id) linkedFamilyId = student.family_id;
    } else if (type === 'file_upload') {
      // Files are handled in a second pass below — we just need to
      // record the field's presence here so the inbox can show the
      // attachment chip alongside the rest of the responses.
      // Stamp a placeholder; the file insert loop overwrites with
      // the file's display name + reference.
    } else {
      const v = fd.get(key);
      if (v != null) responses[key] = typeof v === 'string' ? v : String(v);
    }
  }

  // Conditional-required validation for file_upload fields. The schema
  // can opt out of `required` and instead set `required_unless: { field,
  // value }` — the upload is required UNLESS that field equals that
  // value. Used by the incident form so accidents demand a photo but
  // plain incidents don't.
  for (const block of blocks) {
    if (String(block.type ?? '') !== 'file_upload') continue;
    const key = String(block.key ?? '').trim();
    if (!key) continue;
    const ru = (block as Record<string, unknown>).required_unless as { field?: string; value?: string } | undefined;
    if (!ru?.field) continue;
    const sibling = String(fd.get(String(ru.field)) ?? '').trim();
    const isRequired = sibling !== String(ru.value ?? '');
    if (!isRequired) continue;
    const file = fd.get(key);
    const hasFile = file instanceof File && file.size > 0;
    if (!hasFile) {
      return NextResponse.json({
        error: 'photo_required',
        detail: `A photo is required when ${ru.field} is not "${ru.value}". Please attach a file and resubmit.`,
      }, { status: 400 });
    }
  }

  // Default the assigned_to to the first notify_emails entry (Lexi).
  const assignedTo = (def.notify_emails && def.notify_emails.length > 0)
    ? def.notify_emails[0]
    : null;

  // Family + student get linked when the form included a student_picker
  // (incident report today). Parent column stays NULL — incidents are
  // submitted BY a teacher, not by a parent.
  const ins = await query<{ id: string }>(
    `INSERT INTO portal_form_submissions
       (school_id, form_definition_id, family_id, parent_id, student_id,
        responses, status, submitted_at, is_test,
        submitter_email, assigned_to_email, resolved_status)
     VALUES ($1, $2, $6, NULL, $7,
             $3::jsonb, 'submitted', now(), false,
             $4, $5, 'pending')
     RETURNING id`,
    [session.school_id, formDefId, JSON.stringify(responses), teacherEmail, assignedTo, linkedFamilyId, linkedStudentId],
  );
  const submissionId = ins.rows[0].id;

  // Second pass: persist any uploaded files. Storage is the shared
  // portal_form_submission_files table (bytea) — same table the
  // parent-portal repo uses, so the inbox can show parent uploads and
  // staff uploads the same way. Reference is stamped back into the
  // responses JSON via an UPDATE so the inbox can render an attachment
  // chip without joining at read-time.
  const fileRefs: Record<string, { id: string; filename: string; mime_type: string; size_bytes: number }> = {};
  for (const block of blocks) {
    if (String(block.type ?? '') !== 'file_upload') continue;
    const key = String(block.key ?? '').trim();
    if (!key) continue;
    const file = fd.get(key);
    if (!(file instanceof File) || file.size === 0) continue;
    // Reject pathological sizes early. 10MB covers any phone photo;
    // beyond that the bytea round-trip + Postgres TOAST overhead gets
    // unhappy. Bump later if DGM needs PDFs or longer videos.
    const MAX_BYTES = 10 * 1024 * 1024;
    if (file.size > MAX_BYTES) {
      return NextResponse.json({
        error: 'file_too_large',
        detail: `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)}MB; max is 10MB.`,
      }, { status: 400 });
    }
    const buf = Buffer.from(await file.arrayBuffer());
    const displayName = String(block.label ?? key);
    const fileRow = await query<{ id: string }>(
      `INSERT INTO portal_form_submission_files
         (submission_id, school_id, field_key, display_name, original_filename,
          mime_type, size_bytes, contents)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [submissionId, session.school_id, key, displayName, file.name,
       file.type || 'application/octet-stream', file.size, buf],
    );
    fileRefs[key] = {
      id: fileRow.rows[0].id,
      filename: file.name,
      mime_type: file.type || 'application/octet-stream',
      size_bytes: file.size,
    };
  }

  // If we wrote any files, fold their references into responses so
  // the inbox can render attachment chips without a second query.
  // Mark with _type: 'file_upload' so the renderer recognizes it.
  if (Object.keys(fileRefs).length > 0) {
    const updatedResponses = { ...responses };
    for (const [k, ref] of Object.entries(fileRefs)) {
      updatedResponses[k] = { _type: 'file_upload', ...ref };
    }
    await query(
      `UPDATE portal_form_submissions SET responses = $1::jsonb WHERE id = $2`,
      [JSON.stringify(updatedResponses), submissionId],
    );
    // Local in-memory copy gets the same updates so the notification
    // email below sees the attachment refs too.
    Object.assign(responses, updatedResponses);
  }

  // Pull the student_picker card (if present) so the notification
  // email can surface the kid + first-parent contact in the header.
  // Falls through harmlessly when the form has no picker.
  const pickerKey = blocks.find((b) => String(b.type ?? '') === 'student_picker')?.key;
  const pickerVal = pickerKey ? responses[String(pickerKey)] : undefined;
  let studentLabel: string | null = null;
  let primaryParentEmail: string | null = null;
  let primaryParentPhone: string | null = null;
  if (pickerVal && typeof pickerVal === 'object') {
    const card = pickerVal as Record<string, unknown>;
    studentLabel = String(card.full_name ?? card.name ?? '') || null;
    const parents = Array.isArray(card.parents) ? card.parents as Array<Record<string, unknown>> : [];
    // is_primary is sorted first in the SQL, so head of list is the
    // preferred contact when one exists.
    const primary = parents[0];
    if (primary) {
      primaryParentEmail = primary.email ? String(primary.email) : null;
      primaryParentPhone = primary.phone ? String(primary.phone) : null;
    }
  }

  // Notify recipients defined on the form (Lexi for labor/supplies,
  // admin + iTeam for incidents). The student's parents are NOT
  // automatically CC'd — they're surfaced in the email body + the
  // inbox so Lexi can decide whether to call/email them based on
  // severity. Auto-emailing every parent on every minor incident
  // would generate a lot of low-value (or panicked) parent traffic.
  if (def.notify_emails && def.notify_emails.length > 0) {
    const allRecipients = def.notify_emails;
    import('@/lib/forms/notification-email').then(({ renderNotificationEmail }) =>
      import('@/lib/email').then(({ sendBrandedEmail }) => {
        const { subject, html, text } = renderNotificationEmail({
          formDisplayName: def.display_name,
          schoolName: 'Desert Garden Montessori', // could resolve via schools table; cheap shortcut
          submissionId,
          familyLabel: `STAFF REQUEST · ${teacher?.name ? `${teacher.name} (${teacherEmail})` : teacherEmail}`,
          studentLabel,
          parentEmail: primaryParentEmail,
          parentPhone: primaryParentPhone,
          responses,
        });
        return Promise.allSettled(
          allRecipients.map((to) =>
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
