// POST   /api/school/menus/editors        add a menu editor  { email, name? }
// DELETE /api/school/menus/editors?id=…   remove a menu editor
//
// Lets the school decide who may post the monthly menus without asking
// us (the operator page at /admin/[schoolId]/menu-editors still works).
// Auth is the same as posting a menu: a school session plus an identified
// staff member who is already an editor — so the list can only be changed
// by someone who is trusted with it. Nobody can remove themselves, which
// keeps the school from locking itself out.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { query } from '@/lib/db';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { getTeacherIdentity, isValidEmail } from '@/lib/auth/teacher-identity';
import { isMenuEditor } from '@/lib/menus';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function authorize(): Promise<
  | { ok: false; status: 401 | 403; body: { error: string; detail?: string } }
  | { ok: true; schoolId: string; email: string }
> {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return { ok: false, status: 401, body: { error: 'unauthorized' } };
  const teacher = await getTeacherIdentity();
  if (!teacher) {
    return { ok: false, status: 403, body: { error: 'identify_first', detail: 'Pick your name first so we know who is making the change.' } };
  }
  if (!(await isMenuEditor(session.school_id, teacher.email))) {
    return { ok: false, status: 403, body: { error: 'not_a_menu_editor', detail: 'Only a current menu editor can change who the editors are.' } };
  }
  return { ok: true, schoolId: session.school_id, email: teacher.email };
}

export async function POST(request: NextRequest) {
  const auth = await authorize();
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });

  const body = await request.json().catch(() => null) as { email?: string; name?: string } | null;
  const email = (body?.email ?? '').trim().toLowerCase();
  const name = (body?.name ?? '').trim().slice(0, 120) || null;
  if (!isValidEmail(email)) return NextResponse.json({ error: 'bad_email', detail: 'That email address does not look right.' }, { status: 400 });

  const { rows } = await query<{ id: string; email: string; name: string | null }>(
    `INSERT INTO school_menu_editors (school_id, email, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (school_id, email) DO UPDATE SET name = COALESCE(EXCLUDED.name, school_menu_editors.name)
     RETURNING id, lower(email) AS email, name`,
    [auth.schoolId, email, name],
  );
  return NextResponse.json({ ok: true, editor: rows[0] });
}

export async function DELETE(request: NextRequest) {
  const auth = await authorize();
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });

  const id = new URL(request.url).searchParams.get('id');
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'bad_id' }, { status: 400 });

  const { rows } = await query<{ email: string }>(
    `SELECT lower(email) AS email FROM school_menu_editors WHERE id = $1 AND school_id = $2`,
    [id, auth.schoolId],
  );
  if (rows.length === 0) return NextResponse.json({ ok: true });
  if (rows[0].email === auth.email) {
    return NextResponse.json({ error: 'cannot_remove_self', detail: 'You can’t remove yourself. Ask another editor to do it.' }, { status: 400 });
  }
  await query(`DELETE FROM school_menu_editors WHERE id = $1 AND school_id = $2`, [id, auth.schoolId]);
  return NextResponse.json({ ok: true });
}
