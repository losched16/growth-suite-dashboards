// POST /api/school/parent/[parentId]/student-scope
// Body: { student_ids: string[] } — [] clears the restriction (parent
// sees the whole family again, the default).
//
// Sets per-parent student scoping (parent_student_assignments): a parent
// with rows sees ONLY those students in the portal and at the kiosk.
// Built for blended families — e.g. a child's biological father who
// co-parents with Mom but must never see Mom's other children.
// Office-only (school session), parent must belong to the school.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

type Params = Promise<{ parentId: string }>;

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { parentId } = await params;
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return new NextResponse('unauthorized', { status: 401 });

  const { rows: pr } = await query<{ id: string; school_id: string; family_id: string }>(
    `SELECT id, school_id, family_id FROM parents WHERE id = $1`,
    [parentId],
  );
  if (pr.length === 0) return new NextResponse('parent not found', { status: 404 });
  if (pr[0].school_id !== session.school_id) return new NextResponse('forbidden', { status: 403 });

  const body = await request.json().catch(() => ({} as Record<string, unknown>));
  const requested = Array.isArray(body.student_ids)
    ? body.student_ids.map((v: unknown) => String(v).trim()).filter(Boolean)
    : [];

  // Only students of THIS parent's family are valid scope targets.
  const { rows: kids } = await query<{ id: string }>(
    `SELECT id FROM students WHERE family_id = $1 AND status = 'active'`,
    [pr[0].family_id],
  );
  const familyIds = new Set(kids.map((k) => k.id));
  const scoped = requested.filter((id: string) => familyIds.has(id));
  if (requested.length > 0 && scoped.length === 0) {
    return new NextResponse('no valid students for this family', { status: 400 });
  }

  await query(`DELETE FROM parent_student_assignments WHERE parent_id = $1`, [parentId]);
  for (const sid of scoped) {
    await query(
      `INSERT INTO parent_student_assignments (parent_id, student_id, school_id)
       VALUES ($1, $2, $3) ON CONFLICT (parent_id, student_id) DO NOTHING`,
      [parentId, sid, session.school_id],
    );
  }
  return NextResponse.json({ ok: true, restricted_to: scoped });
}
