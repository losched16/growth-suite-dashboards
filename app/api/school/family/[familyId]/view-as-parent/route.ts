// GET /api/school/family/[familyId]/view-as-parent?next=<path>
//
// Returns a 303 redirect to the parent portal's /api/admin-impersonate
// route with a freshly-signed 5-minute token for the family's primary
// active parent. Admin clicks "View as parent" on a family row →
// browser lands in the parent portal logged in as that parent.
//
// Auth: school-session matching the family's school, OR operator
// session. Cross-tenant impersonation is blocked by the school_id
// check.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { query } from '@/lib/db';
import { mintViewAsParentUrl } from '@/lib/auth/view-as-parent-token';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Params = Promise<{ familyId: string }>;

interface ParentRow {
  id: string;
  school_id: string;
  email: string | null;
  first_name: string | null;
  is_primary: boolean;
}

export async function GET(request: NextRequest, { params }: { params: Params }) {
  const { familyId } = await params;
  const next = request.nextUrl.searchParams.get('next') ?? '/home';

  // Auth gate. Either:
  //   - operator session  → can impersonate ANY family
  //   - school session    → can only impersonate families in matching school_id
  const ck = await cookies();
  const isOperator = verifySessionToken(ck.get(SESSION_COOKIE)?.value);
  const schoolSession = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!isOperator && !schoolSession) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Pick the family's primary active parent. Falls back to any active
  // parent if no primary is flagged.
  const { rows } = await query<ParentRow>(
    `SELECT id, school_id, email, first_name, is_primary
       FROM parents
      WHERE family_id = $1 AND status = 'active'
      ORDER BY is_primary DESC, created_at ASC
      LIMIT 1`,
    [familyId],
  );
  const parent = rows[0];
  if (!parent) {
    return NextResponse.json({ error: 'no_active_parent' }, { status: 404 });
  }
  if (!isOperator && schoolSession && parent.school_id !== schoolSession.school_id) {
    return NextResponse.json({ error: 'cross_school_impersonation_blocked' }, { status: 403 });
  }

  const url = mintViewAsParentUrl({
    parentId: parent.id,
    schoolId: parent.school_id,
    next,
  });
  return NextResponse.redirect(url, 303);
}
