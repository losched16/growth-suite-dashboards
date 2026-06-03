// POST /api/school/resources/upload
//
// Multipart upload of a school-level resource (parent handbook, calendar,
// supply list, etc.) that surfaces in the parent portal under
// /resources. Distinct from /api/school/documents/upload, which attaches
// docs to a specific STUDENT — these are school-wide reference materials
// visible to every family at the same school.
//
// Body (multipart/form-data):
//   file        — the document (PDF, image, spreadsheet, etc.)  required
//   title       — display title shown on the portal card           required
//   description — optional 1-2 line sub-label
//   category    — optional grouping label (free-form text, e.g. "Calendar",
//                 "Forms", "2026-27 Supply Lists"). Items without a
//                 category fall into "Other" on the portal.
//   return_to   — relative path to redirect back to after success
//
// School-session auth. school_id read from the cookie — operators can
// only upload to their own school.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB — generous for handbooks / calendars

function bounce(request: NextRequest, returnTo: string | null, qs: { msg?: string; err?: string }) {
  const fallback = `/school/_/resources`;
  const base = returnTo && /^\/school\/[A-Za-z0-9_-]+\//.test(returnTo) ? returnTo : fallback;
  const url = new URL(base, request.url);
  if (qs.msg) url.searchParams.set('msg', qs.msg);
  if (qs.err) url.searchParams.set('err', qs.err);
  return NextResponse.redirect(url, 303);
}

export async function POST(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let fd: FormData;
  try { fd = await request.formData(); }
  catch { return NextResponse.json({ error: 'invalid_form_data' }, { status: 400 }); }

  const title = String(fd.get('title') ?? '').trim();
  const description = String(fd.get('description') ?? '').trim() || null;
  const category = String(fd.get('category') ?? '').trim() || null;
  const returnTo = String(fd.get('return_to') ?? '').trim() || null;
  const file = fd.get('file');

  if (!title) return bounce(request, returnTo, { err: 'Title is required.' });
  if (!file || !(file instanceof File) || file.size === 0) {
    return bounce(request, returnTo, { err: 'Please attach a file.' });
  }
  if (file.size > MAX_BYTES) {
    return bounce(request, returnTo, {
      err: `File is too large (max ${Math.round(MAX_BYTES / 1024 / 1024)} MB).`,
    });
  }

  const bytes = Buffer.from(await file.arrayBuffer());

  // Position: append. Default to (max(position) + 10) within the same
  // category so reorders later have room to slide.
  const { rows: pRows } = await query<{ next_pos: number }>(
    `SELECT COALESCE(MAX(position), 0) + 10 AS next_pos
       FROM school_documents
      WHERE school_id = $1 AND COALESCE(category,'') = COALESCE($2,'')`,
    [session.school_id, category],
  );
  const position = pRows[0]?.next_pos ?? 10;

  await query(
    `INSERT INTO school_documents
       (school_id, title, description, category,
        original_filename, mime_type, size_bytes, contents, position,
        uploaded_by_email)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      session.school_id, title, description, category,
      file.name, file.type || 'application/octet-stream',
      bytes.length, bytes, position,
      session.user_email ?? null,
    ],
  );

  return bounce(request, returnTo, {
    msg: `Uploaded "${title}". Parents will see it in the portal under Resources.`,
  });
}
