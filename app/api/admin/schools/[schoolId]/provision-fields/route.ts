// POST /api/admin/schools/[schoolId]/provision-fields — push the Growth Suite
// field kit into an existing school's GHL sub-account using its stored PIT.
// Fixes a location that never got the full kit (or was created before the kit
// existed). Idempotent — existing fields are skipped, so it's safe to re-run
// and safe to click on a fully-provisioned location (it just reports 0 created).
//
// operator OR the matching school session. ⚠️ LIVE GHL WRITES.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { decrypt } from '@/lib/crypto';
import { loadSchool } from '@/lib/ghl/client';
import { authorizeOperatorOrSchool } from '@/lib/auth/dual';
import { provisionFieldKit } from '@/lib/onboarding/provision-field-kit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60; // ~150 paced GHL writes

type Params = Promise<{ schoolId: string }>;

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId } = await params;
  const auth = await authorizeOperatorOrSchool(schoolId);
  if (!auth.ok) return auth.response;

  const back = (q: { msg?: string; err?: string }) => {
    const url = request.nextUrl.clone();
    url.pathname = `/admin/${schoolId}/field-audit`;
    url.search = '';
    if (q.msg) url.searchParams.set('msg', q.msg);
    if (q.err) url.searchParams.set('err', q.err);
    return NextResponse.redirect(url, 303);
  };

  const school = await loadSchool(schoolId);
  if (!school) return back({ err: 'School not found.' });

  try {
    const pit = decrypt(school.ghl_pit_encrypted, school.ghl_pit_iv, school.ghl_pit_tag);
    const r = await provisionFieldKit(school.ghl_location_id, pit);
    if (r.failed > 0 && r.created === 0 && r.skipped === 0) {
      return back({ err: `Field-kit push failed — check the PIT scopes. First error: ${r.errors[0] ?? 'unknown'}` });
    }
    return back({
      msg: `Field kit provisioned: ${r.created} created, ${r.skipped} already existed${r.failed ? `, ${r.failed} failed` : ''}${r.tagsCreated ? `, ${r.tagsCreated} tags` : ''}. Re-running the audit below.`,
    });
  } catch (err) {
    return back({ err: `Provisioning failed: ${err instanceof Error ? err.message : String(err)}` });
  }
}
