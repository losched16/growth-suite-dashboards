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
import { checkEmbedToken } from '@/lib/auth/embed';
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
  const embedToken = request.nextUrl.searchParams.get('embed_token');

  // Auth gate. Three accepted paths:
  //   - operator session       → can impersonate ANY family
  //   - school session         → can only impersonate families in matching school_id
  //   - embed_token in URL     → can only impersonate families in matching locationId
  //     (the iframe-embedded dashboards inside GHL carry this; cookies
  //     don't always transfer across third-party iframe context, so the
  //     embed token is the reliable auth signal there)
  const ck = await cookies();
  const isOperator = verifySessionToken(ck.get(SESSION_COOKIE)?.value);
  const schoolSession = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);

  // Pick the family's primary active parent. Falls back to any active
  // parent if no primary is flagged. We also fetch the school's
  // locationId so we can validate an embed_token.
  const { rows } = await query<ParentRow & { ghl_location_id: string | null }>(
    `SELECT p.id, p.school_id, p.email, p.first_name, p.is_primary,
            s.ghl_location_id
       FROM parents p
       JOIN schools s ON s.id = p.school_id
      WHERE p.family_id = $1 AND p.status = 'active'
      ORDER BY p.is_primary DESC, p.created_at ASC
      LIMIT 1`,
    [familyId],
  );
  const parent = rows[0];
  if (!parent) {
    return NextResponse.json({ error: 'no_active_parent' }, { status: 404 });
  }

  // Embed token, if supplied, must match the family's school's locationId.
  const embedOk = embedToken && parent.ghl_location_id
    ? checkEmbedToken(parent.ghl_location_id, embedToken)
    : false;

  if (!isOperator && !schoolSession && !embedOk) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isOperator && !embedOk && schoolSession && parent.school_id !== schoolSession.school_id) {
    return NextResponse.json({ error: 'cross_school_impersonation_blocked' }, { status: 403 });
  }

  const url = await mintViewAsParentUrl({
    parentId: parent.id,
    schoolId: parent.school_id,
    next,
  });
  return NextResponse.redirect(url, 303);
}
