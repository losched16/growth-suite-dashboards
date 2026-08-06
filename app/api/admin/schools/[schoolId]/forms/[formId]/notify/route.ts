// POST /api/admin/schools/{schoolId}/forms/{formId}/notify
//
// EXPLICITLY notify the form's target families (portal bell + inbox +
// CRM email per parent). Publishing a form is silent by design — this
// endpoint is the one and only trigger for the family-facing fan-out,
// fired by the builder's "Send notification" button after the school
// has published AND tested the form.
//
// Guards: form must exist + be published (is_active); a repeat send
// within 10 minutes is rejected (double-click protection) — an
// intentional later re-send (e.g. after widening targeting) goes out.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { query } from '@/lib/db';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { checkEmbedToken } from '@/lib/auth/embed';
import { sendFormNotification } from '@/lib/forms/publish-notification';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// The after() email fan-out can take ~2 minutes for a school-wide form
// (350ms pacing per contact) — keep the function alive long enough.
export const maxDuration = 300;

type Params = Promise<{ schoolId: string; formId: string }>;

// Same three-way auth as the form PATCH route: operator session, school
// session for this school, or the per-school embed token (the builder
// opens in a new tab from the CRM iframe where session cookies don't
// follow).
async function authorize(
  schoolId: string,
  embedToken?: string | null,
): Promise<{ ok: true } | { ok: false; status: 401 | 403 }> {
  const ck = await cookies();
  if (verifySessionToken(ck.get(SESSION_COOKIE)?.value)) return { ok: true };
  const ss = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (ss && ss.school_id === schoolId) return { ok: true };
  if (embedToken) {
    const { rows } = await query<{ ghl_location_id: string | null }>(
      `SELECT ghl_location_id FROM schools WHERE id = $1`, [schoolId]);
    const loc = rows[0]?.ghl_location_id;
    if (loc && checkEmbedToken(loc, embedToken)) return { ok: true };
  }
  return { ok: false, status: ss ? 403 : 401 };
}

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId, formId } = await params;
  const auth = await authorize(schoolId, request.nextUrl.searchParams.get('embed_token'));
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: auth.status });

  const result = await sendFormNotification(schoolId, formId, {
    createdBy: 'form builder: send notification',
  });
  if (!result.ok) {
    const status = result.reason === 'form_not_found' ? 404
      : result.reason === 'recently_sent' ? 409
      : 400;
    return NextResponse.json({ error: result.reason }, { status });
  }
  return NextResponse.json({ ok: true, notified: result.notified });
}
