// Dual auth: allow either an operator session OR a school session whose
// school_id matches the route's schoolId.
//
// Use from any /api/admin/schools/[schoolId]/... handler that needs to
// be reachable from BOTH the operator admin UI and the school iframe
// UI (e.g. product CRUD, billing config, FACTS import).
//
// Returns { ok: true, via: 'operator' | 'school' } on success, or a
// ready-to-return NextResponse with the appropriate 401/403 on failure.

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';

export type DualAuthResult =
  | { ok: true; via: 'operator' | 'school' }
  | { ok: false; response: NextResponse };

export async function authorizeOperatorOrSchool(schoolId: string): Promise<DualAuthResult> {
  const ck = await cookies();

  // 1) Operator session (full cross-school access)
  if (verifySessionToken(ck.get(SESSION_COOKIE)?.value)) {
    return { ok: true, via: 'operator' };
  }

  // 2) School session — only valid if the embedded school matches
  //    the schoolId in the route. A school session for school A must
  //    not be allowed to mutate school B's data.
  const school = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (school && school.school_id === schoolId) {
    return { ok: true, via: 'school' };
  }
  if (school && school.school_id !== schoolId) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'forbidden_cross_school' }, { status: 403 }),
    };
  }

  return {
    ok: false,
    response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
  };
}
