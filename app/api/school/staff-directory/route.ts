// Staff-directory maintenance (migration 103).
//   GET    — list the school's directory entries
//   POST   {email, name} — add (or rename via same email)
//   DELETE {email}       — remove
//
// Auth: school session cookie (the office reaches the editor through
// the CRM iframe, same trust model as the forms builder). Scoped to
// the session's school — a session can never edit another school's
// roster.
//
// Removing someone stops them appearing in the "Pick your name"
// dropdown; it does NOT retroactively touch their past submissions,
// and a device where they already identified stays identified until
// the 30-day teacher cookie expires.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { query } from '@/lib/db';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { isValidEmail } from '@/lib/auth/teacher-identity';
import { getStaffDirectory } from '@/lib/auth/staff-directory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function requireSession() {
  const ck = await cookies();
  return verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
}

export async function GET() {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return NextResponse.json({ staff: await getStaffDirectory(session.school_id) });
}

export async function POST(request: NextRequest) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => null) as { email?: string; name?: string } | null;
  const email = String(body?.email ?? '').trim().toLowerCase();
  const name = String(body?.name ?? '').trim();
  if (!isValidEmail(email)) return NextResponse.json({ error: 'invalid_email' }, { status: 400 });
  if (!name) return NextResponse.json({ error: 'name_required' }, { status: 400 });
  if (name.length > 120) return NextResponse.json({ error: 'name_too_long' }, { status: 400 });

  await query(
    `INSERT INTO school_staff_directory (school_id, email, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (school_id, lower(email)) DO UPDATE SET name = EXCLUDED.name`,
    [session.school_id, email, name],
  );
  return NextResponse.json({ ok: true, staff: await getStaffDirectory(session.school_id) });
}

export async function DELETE(request: NextRequest) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => null) as { email?: string } | null;
  const email = String(body?.email ?? '').trim().toLowerCase();
  if (!isValidEmail(email)) return NextResponse.json({ error: 'invalid_email' }, { status: 400 });

  await query(
    `DELETE FROM school_staff_directory WHERE school_id = $1 AND lower(email) = $2`,
    [session.school_id, email],
  );
  return NextResponse.json({ ok: true, staff: await getStaffDirectory(session.school_id) });
}
