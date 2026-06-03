// POST /api/school/students/set-admission-date
//
// Sets students.metadata.date_of_admission for a specific student in
// this school. School-iframe-context auth. Fires a background GHL
// writeback so the value also appears on the family's contact record.
//
// Body (multipart form):
//   student_id          — uuid (required)
//   date_of_admission   — YYYY-MM-DD (required; empty string clears it)
//   return_to           — relative path to redirect back to (optional)

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function bounce(request: NextRequest, returnTo: string | null, qs: { msg?: string; err?: string }) {
  const fallback = '/school/_/family-hub';
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

  const studentId = String(fd.get('student_id') ?? '').trim();
  const dateRaw = String(fd.get('date_of_admission') ?? '').trim();
  const returnTo = String(fd.get('return_to') ?? '').trim() || null;

  if (!studentId || !/^[0-9a-fA-F-]{36}$/.test(studentId)) {
    return bounce(request, returnTo, { err: 'Invalid student id.' });
  }
  if (dateRaw && !/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
    return bounce(request, returnTo, { err: 'Date must be YYYY-MM-DD.' });
  }

  // Verify the student belongs to this school (defense in depth — even
  // though the school session can't reach this endpoint cross-tenant,
  // we still scope by session.school_id).
  const { rows } = await query<{ id: string; first_name: string; last_name: string }>(
    `SELECT id, first_name, last_name FROM students
      WHERE id = $1 AND school_id = $2`,
    [studentId, session.school_id],
  );
  if (rows.length === 0) {
    return bounce(request, returnTo, { err: 'Student not found in this school.' });
  }
  const student = rows[0];

  // Empty string = clear the value. Otherwise write the ISO date.
  if (dateRaw === '') {
    await query(
      `UPDATE students
          SET metadata = COALESCE(metadata, '{}'::jsonb) - 'date_of_admission',
              updated_at = now()
        WHERE id = $1`,
      [studentId],
    );
  } else {
    await query(
      `UPDATE students
          SET metadata = COALESCE(metadata, '{}'::jsonb)
                      || jsonb_build_object('date_of_admission', $2::text),
              updated_at = now()
        WHERE id = $1`,
      [studentId, dateRaw],
    );
  }

  // Fire-and-forget GHL writeback. We need to push the value into the
  // family's GHL contact custom field `student_date_of_admission` for
  // slot 1, or `student_N_date_of_admission` for siblings.
  import('@/lib/billing/admission-date-ghl-writeback')
    .then(({ writebackAdmissionDate }) => writebackAdmissionDate(studentId))
    .catch((e) => console.warn('[set-admission-date] GHL writeback failed:',
      e instanceof Error ? e.message : String(e)));

  return bounce(request, returnTo, {
    msg: dateRaw
      ? `Set admission date for ${student.first_name} ${student.last_name} to ${dateRaw}.`
      : `Cleared admission date for ${student.first_name} ${student.last_name}.`,
  });
}
