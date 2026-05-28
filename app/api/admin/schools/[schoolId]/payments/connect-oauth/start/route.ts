// POST /api/admin/schools/{schoolId}/payments/connect-oauth/start
//
// Kicks off the "connect EXISTING Stripe account" path. Builds an
// authorize URL + HMAC-signed state token, then 303-redirects the
// operator to Stripe's OAuth consent page.
//
// Pair with: connect-oauth/callback/route.ts (the callback Stripe
// hands the operator back to after they authorize).

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { signOAuthState, buildAuthorizeUrl } from '@/lib/stripe/connect-oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

type Params = Promise<{ schoolId: string }>;

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId } = await params;

  const { rows } = await query<{ name: string }>(
    `SELECT name FROM schools WHERE id = $1`, [schoolId],
  );
  if (rows.length === 0) {
    return NextResponse.json({ error: 'school_not_found' }, { status: 404 });
  }
  const { rows: bRows } = await query<{ support_email: string | null }>(
    `SELECT support_email FROM school_branding WHERE school_id = $1`, [schoolId],
  );
  const supportEmail = bRows[0]?.support_email ?? 'support@mygrowthsuite.com';

  // Build state + redirect URL.
  let state: string;
  let authorizeUrl: string;
  try {
    state = signOAuthState(schoolId);
    const origin = request.nextUrl.origin;
    const redirectUri = `${origin}/api/admin/schools/${schoolId}/payments/connect-oauth/callback`;
    authorizeUrl = buildAuthorizeUrl({ state, redirectUri, schoolEmail: supportEmail });
  } catch (err) {
    // Most likely STRIPE_CLIENT_ID isn't configured — surface that as
    // a real error rather than silently bouncing back. Operator can
    // wire the env var in Vercel and try again.
    const msg = err instanceof Error ? err.message : String(err);
    const back = new URL(`/school/_/payments?tab=settings`, request.url);
    back.searchParams.set('err', `OAuth setup failed: ${msg}`);
    return NextResponse.redirect(back, 303);
  }

  return NextResponse.redirect(authorizeUrl, 303);
}
