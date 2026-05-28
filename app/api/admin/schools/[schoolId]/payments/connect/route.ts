// POST /api/admin/schools/{schoolId}/payments/connect
//
// Starts (or resumes) Stripe Connect Standard onboarding for a school.
// Operator-authenticated via the existing proxy session check.
//
// Behavior:
//   - Reads the school record for name + contact info.
//   - Creates or reuses the school's Stripe Account.
//   - Generates a fresh Account Link onboarding URL.
//   - 303-redirects the operator to Stripe.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { beginConnectOnboarding } from '@/lib/stripe/connect-onboarding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type Params = Promise<{ schoolId: string }>;

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId } = await params;

  const { rows } = await query<{ name: string }>(
    `SELECT name FROM schools WHERE id = $1`, [schoolId],
  );
  if (rows.length === 0) {
    return NextResponse.json({ error: 'school_not_found' }, { status: 404 });
  }
  const school = rows[0];

  // For the school's contact email, prefer the support email from branding
  // (since that's the school-facing inbox). Operator's email is captured
  // separately as audit metadata.
  const { rows: bRows } = await query<{ support_email: string | null }>(
    `SELECT support_email FROM school_branding WHERE school_id = $1`, [schoolId],
  );
  const supportEmail = bRows[0]?.support_email ?? 'support@mygrowthsuite.com';

  // Allow callers (e.g. the school-iframe Payments hub) to override where
  // Stripe sends the operator back to after onboarding. Must be a same-
  // origin path starting with /school/ or /admin/ — never an absolute URL
  // (security: don't redirect to attacker-controlled hosts).
  const origin = request.nextUrl.origin;
  let returnPath = `/admin/${schoolId}/payments`;
  try {
    const fd = await request.formData();
    const candidate = String(fd.get('return_to') ?? '').trim();
    if (candidate && /^\/(school|admin)\/[A-Za-z0-9_-]+\//.test(candidate)) {
      returnPath = candidate;
    }
  } catch {
    // No form data / not multipart — fall through to the admin default.
  }
  const returnBaseUrl = `${origin}${returnPath}`;

  try {
    const r = await beginConnectOnboarding({
      schoolId,
      schoolName: school.name,
      schoolEmail: supportEmail,
      operatorEmail: 'operator@growthsuite.local', // proxy doesn't expose operator id today
      returnBaseUrl,
    });
    return NextResponse.redirect(r.onboardingUrl, 303);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const back = new URL(returnBaseUrl);
    back.searchParams.set('err', `Stripe onboarding failed: ${msg}`);
    return NextResponse.redirect(back, 303);
  }
}
