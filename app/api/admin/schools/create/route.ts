// Onboard a new school. Form fields:
//   - name (required)
//   - ghl_location_id (required) — from GHL Settings → Business Info
//   - ghl_pit (required) — Private Integration Token with scopes:
//       contacts.readonly, contacts.write,
//       locations/customFields.readonly,
//       associations.write, associations/relation.write,
//       opportunities.readonly, conversations.readonly, conversations/message.write
//
// Behavior:
//   1. Validates the PIT by hitting /locations/{id}/customFields
//   2. AES-256-GCM encrypts the PIT
//   3. Inserts row into schools
//   4. Redirects to /admin/{newSchoolId} for sync + promote-p2

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { provisionSchool, ProvisionSchoolError } from '@/lib/onboarding/provision-school';

export const maxDuration = 30;

export async function POST(request: NextRequest) {
  // OPERATOR-ONLY (security remediation 1.2). Creating a school (which stores
  // an encrypted GHL PIT and provisions a tenant) was fully anonymous — anyone
  // could POST here. There is no schoolId to scope to, so this requires a
  // platform operator session, never a school session.
  const ck = await cookies();
  if (!verifySessionToken(ck.get(SESSION_COOKIE)?.value)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    const form = await request.formData();
    // All provisioning (validate PIT → insert school + starter dashboards +
    // payment config + branding → derive field schema) lives in the shared
    // provisionSchool() lib, so this route and the one-click onboarding
    // "Provision & connect" action stay in lockstep.
    const { schoolId, academicYear } = await provisionSchool({
      name: String(form.get('name') ?? ''),
      locationId: String(form.get('ghl_location_id') ?? ''),
      pit: String(form.get('ghl_pit') ?? ''),
      academicYear: String(form.get('academic_year') ?? ''),
    });

    const url = request.nextUrl.clone();
    url.pathname = `/admin/${schoolId}`;
    url.search = '';
    url.searchParams.set('msg',
      `Created school (${academicYear}) with starter dashboards + payment config (dry-run mode). ` +
      `Next: 1) run the Field audit (/admin/${schoolId}/field-audit) to verify the location's custom fields, ` +
      `2) "Sync from GHL" — after that the school self-serves: Settings, Add dashboard (incl. classroom hubs), ` +
      `Forms → New form (templates), and Payments (tuition grids + plans).`,
    );
    return NextResponse.redirect(url, 303);
  } catch (err) {
    if (err instanceof ProvisionSchoolError) return back(request, { err: err.message });
    return back(request, { err: `Failed: ${err instanceof Error ? err.message : String(err)}` });
  }
}

function back(request: NextRequest, q: { msg?: string; err?: string }) {
  const url = request.nextUrl.clone();
  url.pathname = '/admin/schools/new';
  url.search = '';
  if (q.msg) url.searchParams.set('msg', q.msg);
  if (q.err) url.searchParams.set('err', q.err);
  return NextResponse.redirect(url, 303);
}
