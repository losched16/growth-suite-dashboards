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

  // Pull the school's location id so we can route any error redirect
  // back to a valid /school/<locationId>/payments page (the old code
  // used "/school/_/payments" which 404s, so when STRIPE_CLIENT_ID was
  // missing the operator just saw a 404 in the new tab instead of the
  // actual error message).
  const { rows } = await query<{ name: string; ghl_location_id: string }>(
    `SELECT name, ghl_location_id FROM schools WHERE id = $1`, [schoolId],
  );
  if (rows.length === 0) {
    return NextResponse.json({ error: 'school_not_found' }, { status: 404 });
  }
  const locationId = rows[0].ghl_location_id;
  const { rows: bRows } = await query<{ support_email: string | null }>(
    `SELECT support_email FROM school_branding WHERE school_id = $1`, [schoolId],
  );
  const supportEmail = bRows[0]?.support_email ?? 'support@mygrowthsuite.com';

  // Build state + redirect URL.
  //
  // SINGLE platform-wide callback URL (encoded in the state) rather than
  // a per-school path: Stripe Connect requires the redirect_uri passed to
  // OAuth to exactly match one of the URIs registered in your platform's
  // Dashboard. With one redirect URI configured in Stripe, every school
  // OAuth-connects through the same endpoint and the schoolId travels
  // via the HMAC-signed state.
  //
  // Stripe Dashboard → Settings → Connect → Onboarding options →
  //   Standard → Redirect URIs → must include the URL we set below.
  let state: string;
  let authorizeUrl: string;
  try {
    state = signOAuthState(schoolId);
    const origin = request.nextUrl.origin;
    const redirectUri = `${origin}/api/stripe-connect/callback`;
    authorizeUrl = buildAuthorizeUrl({ state, redirectUri, schoolEmail: supportEmail });
  } catch (err) {
    // Most likely STRIPE_CLIENT_ID isn't configured. Send the operator
    // to a friendly HTML error page with the underlying reason — far
    // better UX than a raw 404 or JSON blob in the new tab the form
    // opened.
    const msg = err instanceof Error ? err.message : String(err);
    const helpUrl = `${request.nextUrl.origin}/school/${locationId}/payments?tab=settings&err=${encodeURIComponent('Connect-existing flow is not set up yet: ' + msg)}`;
    const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Stripe Connect not configured</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:600px;margin:48px auto;padding:24px;color:#0f172a}h1{margin:0 0 8px;font-size:18px}code{background:#f1f5f9;padding:2px 6px;border-radius:4px;font-size:13px}.box{border-left:4px solid #f59e0b;background:#fffbeb;padding:12px 16px;border-radius:6px;margin:16px 0}a{color:#2563eb}</style>
</head><body>
<h1>⚠️ The &quot;Connect existing Stripe account&quot; flow isn&rsquo;t configured yet.</h1>
<p class="box"><strong>Underlying reason:</strong> ${msg.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))}</p>
<p>To enable this flow:</p>
<ol>
<li>In the <a href="https://dashboard.stripe.com/settings/connect/onboarding-options/oauth" target="_blank">Stripe Dashboard</a> under <em>Connect → Onboarding options</em>, toggle <strong>Standard</strong> + enable <strong>OAuth</strong>.</li>
<li>Copy the <strong>OAuth client ID</strong> (starts with <code>ca_…</code>).</li>
<li>Add it to Vercel as <code>STRIPE_CLIENT_ID</code> and redeploy.</li>
</ol>
<p>Once set, this button will redirect to Stripe&rsquo;s authorize page like normal.</p>
<p><a href="${helpUrl}">← Back to school payments settings</a></p>
</body></html>`;
    return new NextResponse(html, {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  return NextResponse.redirect(authorizeUrl, 303);
}
