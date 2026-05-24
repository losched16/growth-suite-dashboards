import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  SCHOOL_SESSION_COOKIE,
  SCHOOL_SESSION_TTL_S,
  mintSchoolSession,
  verifyGhlMenuLinkJwt,
} from '@/lib/auth/school';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';

// GET or POST /api/auth/ghl-exchange?token=<GHL JWT>
//
// Per brief §10.1, the GHL Custom Menu Link is configured to point at this
// URL with `?token={{token}}`. GHL signs and substitutes the JWT. We
// support GET (preferred — what the menu link actually issues) and POST
// (kept for future programmatic exchange).
async function exchange(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token');
  if (!token) {
    return NextResponse.json({ error: 'token query param required' }, { status: 400 });
  }

  let claims: Awaited<ReturnType<typeof verifyGhlMenuLinkJwt>>;
  try {
    claims = await verifyGhlMenuLinkJwt(token);
  } catch (err) {
    return NextResponse.json(
      { error: `invalid GHL token: ${err instanceof Error ? err.message : String(err)}` },
      { status: 401 }
    );
  }

  if (!claims.locationId) {
    return NextResponse.json({ error: 'token missing locationId' }, { status: 400 });
  }

  const school = await loadSchoolByLocationId(claims.locationId);
  if (!school) {
    return NextResponse.json(
      { error: `unknown school for location ${claims.locationId}` },
      { status: 404 }
    );
  }

  const sessionJwt = await mintSchoolSession({
    school_id: school.id,
    ghl_location_id: school.ghl_location_id,
    user_email: claims.email ?? '',
    user_name: claims.name ?? '',
    via: 'ghl',
  });

  const url = request.nextUrl.clone();
  url.pathname = `/school/${school.ghl_location_id}`;
  url.search = '';
  const response = NextResponse.redirect(url, 303);
  response.cookies.set({
    name: SCHOOL_SESSION_COOKIE,
    value: sessionJwt,
    httpOnly: true,
    secure: true,
    // SameSite=None required for iframe context. Browsers reject it over
    // plain HTTP; this works in production (HTTPS) and over ngrok in dev.
    sameSite: 'none',
    path: '/',
    maxAge: SCHOOL_SESSION_TTL_S,
  });
  return response;
}

export const GET = exchange;
export const POST = exchange;
