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
import { query } from '@/lib/db';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { checkEmbedToken } from '@/lib/auth/embed';

export type DualAuthResult =
  | { ok: true; via: 'operator' | 'school' }
  | { ok: false; response: NextResponse };

export async function authorizeOperatorOrSchool(
  schoolId: string,
  opts?: {
    // Per-school embed token (HMAC of the school's locationId — the same
    // credential the GHL iframe URL carries). Accepting it here covers
    // target="_blank" form posts out of the iframe: the school-session
    // cookie is Partitioned (CHIPS), so it exists only inside the GHL
    // iframe partition and never attaches in the new tab. Pass the token
    // through a hidden form input instead — same trust model as the CSV
    // export + view-as-parent routes.
    embedToken?: string | null;
  },
): Promise<DualAuthResult> {
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

  // 3) Embed token — school-scoped by construction (verified against the
  //    route school's own locationId, so a token for school A can never
  //    authorize school B).
  if (opts?.embedToken) {
    const { rows } = await query<{ ghl_location_id: string | null }>(
      `SELECT ghl_location_id FROM schools WHERE id = $1`, [schoolId],
    );
    const locationId = rows[0]?.ghl_location_id;
    if (locationId && checkEmbedToken(locationId, opts.embedToken)) {
      return { ok: true, via: 'school' };
    }
  }

  return {
    ok: false,
    response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
  };
}
