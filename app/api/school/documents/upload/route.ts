// POST /api/school/documents/upload
//
// Multipart form upload: file blob + metadata (title, category, etc.).
// School-session-authed; school_id read from the cookie (operator can't
// upload to another school's student record).
//
// Stored as bytea in student_documents.file_bytes. 10MB cap is enforced
// both client-side (HTML accept) and server-side (size_bytes CHECK in
// the table) — we reject early here if the upload is over.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const MAX_BYTES = 10 * 1024 * 1024;        // 10MB — matches table CHECK
// Legacy hardcoded categories — used as a fallback when a school has
// no custom category list yet. Once school_document_categories has
// rows for this school, we validate against that list instead.
// "other" intentionally dropped — schools that want a specific list
// won't get a meaningless catch-all bucket.
const LEGACY_CATEGORIES = ['health', 'enrollment', 'iep', 'transcript'];

export async function POST(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const fd = await request.formData();
  const studentId = String(fd.get('student_id') ?? '').trim();
  const title = String(fd.get('title') ?? '').trim();
  const categoryRaw = String(fd.get('category') ?? '').trim().toLowerCase();
  const description = String(fd.get('description') ?? '').trim() || null;
  const visibleToTeacher = fd.get('visible_to_teacher') === '1' || fd.get('visible_to_teacher') === 'on';
  const visibleToParent = fd.get('visible_to_parent') === '1' || fd.get('visible_to_parent') === 'on';
  const expiresAtRaw = String(fd.get('expires_at') ?? '').trim();
  const file = fd.get('file');

  if (!studentId) return NextResponse.json({ ok: false, error: 'student_id required' }, { status: 400 });
  if (!title)     return NextResponse.json({ ok: false, error: 'title required' }, { status: 400 });
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ ok: false, error: 'file required' }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ ok: false, error: 'file is empty' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ ok: false, error: `file too large (max ${MAX_BYTES} bytes)` }, { status: 413 });
  }
  // Resolve allowed categories for this school. School-specific list
  // (managed via /api/school/document-categories) wins; legacy
  // hardcoded list is the fallback for schools that haven't seeded
  // their own list yet.
  const { rows: schoolCats } = await query<{ key: string }>(
    `SELECT key FROM school_document_categories WHERE school_id = $1`,
    [session.school_id],
  );
  const allowedKeys = schoolCats.length > 0
    ? schoolCats.map((c) => c.key)
    : LEGACY_CATEGORIES;
  if (!allowedKeys.includes(categoryRaw)) {
    return NextResponse.json({
      ok: false,
      error: 'invalid_category',
      detail: `"${categoryRaw}" is not a recognized category for this school. Available: ${allowedKeys.join(', ')}.`,
    }, { status: 400 });
  }
  const category = categoryRaw;
  const expiresAt = /^\d{4}-\d{2}-\d{2}$/.test(expiresAtRaw) ? expiresAtRaw : null;

  // Verify the student belongs to this school. Prevents cross-school
  // doc-attachment even if someone crafts a request with a foreign id.
  const { rows: sRows } = await query<{ id: string }>(
    `SELECT id FROM students WHERE id = $1 AND school_id = $2`,
    [studentId, session.school_id],
  );
  if (sRows.length === 0) {
    return NextResponse.json({ ok: false, error: 'student not found on this school' }, { status: 404 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());

  const { rows: insertRows } = await query<{ id: string }>(
    `INSERT INTO student_documents
       (school_id, student_id, title, category, description,
        file_name, mime_type, size_bytes, file_bytes,
        uploaded_by, visible_to_teacher, visible_to_parent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      session.school_id, studentId, title, category, description,
      file.name, file.type || 'application/octet-stream', bytes.length, bytes,
      session.user_email ?? null, visibleToTeacher, visibleToParent, expiresAt,
    ],
  );

  return NextResponse.json({ ok: true, id: insertRows[0].id, size_bytes: bytes.length });
}
