// Next.js 16 renamed `middleware` to `proxy`. Same behavior.
//
// Two distinct gates handled in one file:
//   - /school/*  → school admin session JWT cookie (or dev-token bypass)
//   - everything else (admin UI) → operator session cookie
//
// Public (no gate), excluded from the matcher entirely:
//   - /login, /api/login, /api/logout — operator auth surface
//   - /api/v1/* — bearer-token auth at route handler
//   - /api/auth/* — GHL JWT exchange
//   - Next.js static plumbing
//
// Dev-token bypass for /school/*: gated by NODE_ENV !== 'production' AND
// DEV_AUTH_BYPASS=true (see lib/auth/school.ts). When present, sets the
// school session cookie inline so subsequent navigation works without
// re-supplying ?dev_token. Loud console.warn on every use; silent in
// production (the env gate prevents it from firing at all).

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
// Operator-auth helpers kept around in case we re-enable the password
// layer later; not imported here while the gate is a no-op.
// import { SESSION_COOKIE as OPERATOR_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import {
  SCHOOL_SESSION_COOKIE,
  SCHOOL_SESSION_TTL_S,
  checkDevBypass,
  devBypassEnabled,
  mintSchoolSession,
  verifySchoolSession,
} from '@/lib/auth/school';
import { checkEmbedToken } from '@/lib/auth/embed';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;

  if (path.startsWith('/school/')) {
    return guardSchool(request);
  }
  return guardOperator(request);
}

function guardOperator(request: NextRequest) {
  // Admin pages are designed to be embedded inside the school's GHL
  // portal. GHL is the trust boundary — anyone who's authenticated
  // there sees the appropriate sub-account's iframe. We don't impose
  // a separate password layer on top.
  //
  // School-scoped routes still pass the schoolId in the URL path
  // (UUID, non-public, ~128 bits of entropy), so an attacker would
  // need to know that ID to address a specific school.
  //
  // If you later want to lock this down again, restore the cookie
  // check below.
  //
  // const token = request.cookies.get(OPERATOR_COOKIE)?.value;
  // if (verifySessionToken(token)) return NextResponse.next();
  // const url = request.nextUrl.clone(); url.pathname = '/login';
  // return NextResponse.redirect(url);
  return NextResponse.next();
}

async function guardSchool(request: NextRequest) {
  // ── Cookie check (wrapped) ─────────────────────────────────────────
  // verifySchoolSession can throw on a malformed/expired JWT. If it
  // does, we DON'T want the whole iframe to die — we want to fall
  // through to the auto-mint path below. Browsers occasionally serve
  // up a stale cookie after a deploy (signing key rotation, partition
  // gap, whatever); the right move is to just mint a fresh one.
  try {
    const sessionToken = request.cookies.get(SCHOOL_SESSION_COOKIE)?.value;
    if (sessionToken) {
      const session = await verifySchoolSession(sessionToken);
      if (session) return passThroughWithChrome(request);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[guardSchool] cookie verify threw, falling through to mint:', e);
  }

  // ── Auto-mint session from location_id in the URL ──────────────────
  // Same trust model as the operator gate (which we removed): the
  // unguessable id in the URL is the boundary. When a request hits a
  // /school/{locationId}/... path without a valid session cookie, we
  // mint one from that location_id and pass through. Subsequent API
  // calls inside the iframe re-use the cookie.
  //
  // Cross-site iframe cookie gotcha: Chrome/Safari may drop the
  // Partitioned cookie on some navigation paths even when we set it
  // correctly. That's fine — the request just comes back here without
  // a cookie and we mint another one. Each mint must therefore be
  // cheap and idempotent (it is — single DB lookup + JWT sign).
  //
  // If location_id doesn't map to a school, we 404 (correct: bad URL).
  const locationId = extractLocationId(request);
  if (locationId) {
    try {
      const school = await loadSchoolByLocationId(locationId);
      if (!school) {
        // eslint-disable-next-line no-console
        console.warn('[guardSchool] location_id not found in DB:', locationId);
        return new NextResponse(
          `No school is wired up for this GHL location (${locationId}). ` +
          `Open Growth Suite directly to provision it.`,
          { status: 404, headers: { 'Content-Type': 'text/plain' } },
        );
      }
      const jwt = await mintSchoolSession({
        school_id: school.id,
        ghl_location_id: school.ghl_location_id,
        user_email: 'embed@iframe',
        user_name: 'embed',
        via: 'ghl',
      });
      const response = passThroughWithChrome(request);
      response.cookies.set({
        name: SCHOOL_SESSION_COOKIE,
        value: jwt,
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        path: '/',
        maxAge: SCHOOL_SESSION_TTL_S,
        partitioned: true,
      });
      // Don't let the browser/edge cache a transient 401 or an old
      // unauthenticated render. Each request should re-hit this proxy
      // so the cookie gets re-set when partition state is lost.
      response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      return response;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[guardSchool] mint flow threw:', e);
      return new NextResponse(
        `Auto-auth failed: ${e instanceof Error ? e.message : String(e)}`,
        { status: 500, headers: { 'Content-Type': 'text/plain' } },
      );
    }
  }

  // Embed token (production-safe, anonymous-per-school auth for iframe
  // embeds inside GHL Dashboard widgets). Token is HMAC(secret, locationId).
  // On match: mint a session cookie and redirect to the same URL minus the
  // token, so subsequent navigation inside the iframe doesn't need it.
  const embedToken = request.nextUrl.searchParams.get('embed_token');
  if (embedToken) {
    const locationId = extractLocationId(request);
    if (locationId && checkEmbedToken(locationId, embedToken)) {
      const school = await loadSchoolByLocationId(locationId);
      if (school) {
        const jwt = await mintSchoolSession({
          school_id: school.id,
          ghl_location_id: school.ghl_location_id,
          user_email: 'embed@iframe',
          user_name: 'embed',
          via: 'ghl',
        });
        const url = request.nextUrl.clone();
        url.searchParams.delete('embed_token');
        const response = NextResponse.redirect(url, 303);
        response.cookies.set({
          name: SCHOOL_SESSION_COOKIE,
          value: jwt,
          httpOnly: true,
          secure: true,
          sameSite: 'none',
          path: '/',
          maxAge: SCHOOL_SESSION_TTL_S,
          // CHIPS (Partitioned cookies). Required so the cookie survives in
          // a cross-site iframe when the browser is blocking third-party
          // cookies by default (Chrome 114+, Safari ITP). Without this, the
          // cookie set by *.vercel.app inside a GHL iframe is dropped on
          // the follow-up request after our 303 redirect → 401 → "refused
          // to connect" in the iframe.
          partitioned: true,
        });
        return response;
      }
    }
  }

  // Dev-token bypass — only fires when both the env-var gate AND the
  // shared bearer match. Silent in production: the env-gate keeps it off.
  const devToken = request.nextUrl.searchParams.get('dev_token');
  if (devBypassEnabled() && devToken && checkDevBypass(devToken)) {
    const locationId = extractLocationId(request);
    if (locationId) {
      const school = await loadSchoolByLocationId(locationId);
      if (school) {
        const jwt = await mintSchoolSession({
          school_id: school.id,
          ghl_location_id: school.ghl_location_id,
          user_email: 'dev@local',
          user_name: 'dev bypass',
          via: 'dev',
        });
        const url = request.nextUrl.clone();
        url.searchParams.delete('dev_token');
        const response = NextResponse.redirect(url, 303);
        response.cookies.set({
          name: SCHOOL_SESSION_COOKIE,
          value: jwt,
          httpOnly: true,
          secure: true,
          sameSite: 'none',
          path: '/',
          maxAge: SCHOOL_SESSION_TTL_S,
          // See note above on Partitioned. Same rationale applies even for
          // dev-bypass since dev iframes also load cross-site.
          partitioned: true,
        });
        // eslint-disable-next-line no-console
        console.warn(
          '[DEV_AUTH_BYPASS] minted session via ?dev_token for',
          locationId,
          '— this MUST NOT appear in production logs',
        );
        return response;
      }
    }
  }

  return new NextResponse(
    'Session expired or not authenticated. Refresh from Growth Suite to re-authenticate.',
    { status: 401, headers: { 'Content-Type': 'text/plain' } },
  );
}

function extractLocationId(request: NextRequest): string | null {
  const parts = request.nextUrl.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'school' || !parts[1]) return null;
  return parts[1];
}

// /school/* pages support a `?chrome=none` query param that hides the
// sidebar nav so the iframe shows only the dashboard content. Operators
// embed each dashboard as a separate iframe in GHL — they don't want the
// list of all dashboards visible inside every embed (since some
// dashboards like Tuition should be hidden from staff but visible to
// admins). Next.js 16 layouts can't read searchParams, so the proxy
// reads it here and propagates via the `x-chrome` request header which
// the school layout reads via next/headers.
function passThroughWithChrome(request: NextRequest): NextResponse {
  // Resolve effective chrome:
  //   1. Explicit `?chrome=none` query param (operator chooses per-iframe)
  //   2. Auto-force `none` for the GHL-native Payments hub — it brings
  //      its own header + sub-nav and must never render inside the
  //      Growth Suite sidebar (would look like two competing chromes
  //      stacked inside the same iframe).
  const queryChrome = request.nextUrl.searchParams.get('chrome') ?? '';
  const path = request.nextUrl.pathname;
  const isPaymentsHub = /^\/school\/[^/]+\/payments(?:\/.*)?$/.test(path);
  const chrome = queryChrome || (isPaymentsHub ? 'none' : '');
  const response = chrome
    ? NextResponse.next({
        request: {
          headers: (() => {
            const h = new Headers(request.headers);
            h.set('x-chrome', chrome);
            return h;
          })(),
        },
      })
    : NextResponse.next();
  // /school/* is always inside a cross-site iframe. Stale caches +
  // partitioned cookies are a bad combination — disk-cached 401 pages
  // would surface as "page couldn't load" inside GHL. Force a fresh
  // round-trip every time so the auto-mint can re-run if needed.
  response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  return response;
}

export const config = {
  matcher: [
    // Excluded from the operator/school gate. `api/school` handlers do
    // their own school-session check via verifySchoolSession() — the proxy
    // would otherwise redirect them to the operator login.
    '/((?!login|api/login|api/logout|api/v1|api/auth|api/cron|api/export|api/school|_next/static|_next/image|favicon.ico).*)',
  ],
};
