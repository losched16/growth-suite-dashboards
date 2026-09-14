// GET /api/school/documents/list?student_id=<uuid>
//
// Returns the documents attached to a single student — office uploads
// plus files attached to portal forms filled out for that child. Used by
// the inline cell on the Student Roster row so the operator can see a
// student's docs without leaving the roster.
//
// School-session-authed; results are scoped to the session's school
// even though the URL passes a student_id (defense in depth — a
// crafted student_id from another school returns 404).

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface DocRow {
  id: string;
  title: string;
  category: string | null;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  uploaded_at: string;
  uploaded_by: string | null;
  expires_at: string | null;
  visible_to_teacher: boolean;
  visible_to_parent: boolean;
  // 'document' = office upload (student_documents). 'form_upload' = a file
  // attached to a portal form filled out for this child; it streams from
  // the submission-files route and can't be deleted from here.
  source: 'document' | 'form_upload';
  form_name: string | null;
  // Who attached a form upload: a parent in the portal, or staff on a
  // staff form (e.g. an incident-report photo).
  uploader_kind: 'parent' | 'staff' | null;
}

export async function GET(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const studentId = (request.nextUrl.searchParams.get('student_id') ?? '').trim();
  if (!studentId) {
    return NextResponse.json({ ok: false, error: 'student_id required' }, { status: 400 });
  }

  // `audience=teacher` filters out admin-only documents
  // (visible_to_teacher=false). The default behavior shows everything —
  // operators viewing the StudentDocumentsBrowser dashboard need the
  // full list. The DocumentsCell on the teacher classroom hub roster
  // passes audience=teacher so admin-only files (e.g. internal HR
  // notes) don't leak to teachers.
  const audience = (request.nextUrl.searchParams.get('audience') ?? '').trim();
  const teacherOnly = audience === 'teacher';

  // school_id check is applied in the WHERE, so a cross-school
  // student_id returns an empty list (not a leak).
  const { rows: docs } = await query<DocRow>(
    `SELECT id, title, category, file_name, mime_type, size_bytes,
            uploaded_at, uploaded_by, expires_at,
            visible_to_teacher, visible_to_parent,
            'document' AS source, NULL AS form_name, NULL AS uploader_kind
       FROM student_documents
      WHERE school_id = $1 AND student_id = $2
        AND ($3 = false OR visible_to_teacher = true)`,
    [session.school_id, studentId, teacherOnly],
  );

  // Files attached to portal forms filled out for this child — same rules
  // as the Documents dashboard (non-test, submitted), so the two agree.
  // Shown to teachers too, matching that dashboard.
  const { rows: formUploads } = await query<DocRow>(
    `SELECT pf.id,
            pf.original_filename AS title,
            NULL AS category,
            pf.original_filename AS file_name, pf.mime_type, pf.size_bytes,
            pf.uploaded_at,
            NULLIF(TRIM(CONCAT_WS(' ', p.first_name, p.last_name)), '') AS uploaded_by,
            NULL AS expires_at,
            true AS visible_to_teacher, true AS visible_to_parent,
            'form_upload' AS source,
            d.display_name AS form_name,
            CASE WHEN COALESCE(d.audience, 'parents') = 'staff' THEN 'staff' ELSE 'parent' END AS uploader_kind
       FROM portal_form_submission_files pf
       JOIN portal_form_submissions sub ON sub.id = pf.submission_id
       JOIN portal_form_definitions d   ON d.id = sub.form_definition_id
       LEFT JOIN parents p ON p.id = pf.uploaded_by_parent_id
      WHERE pf.school_id = $1 AND sub.student_id = $2
        AND COALESCE(sub.is_test, false) = false
        AND sub.status IN ('submitted', 'paid', 'pending_payment', 'legacy_imported')`,
    [session.school_id, studentId],
  );

  const rows = [...docs, ...formUploads].sort((a, b) =>
    new Date(b.uploaded_at).getTime() - new Date(a.uploaded_at).getTime());

  return NextResponse.json({ ok: true, documents: rows });
}
