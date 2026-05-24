// Operator action: promote each family's Parent 2 into its own GHL
// contact, linked to Parent 1 via the GHL Associations API.
//
// Form fields:
//   - dry_run = '1'    → preview only, no GHL or DB writes
//   - family_id (opt)  → restrict to a single family (smoke test)
//
// Idempotent — already-promoted families are skipped.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { promoteParent2sForSchool } from '@/lib/sync/promote-parent2';
import { query } from '@/lib/db';

export const maxDuration = 300; // up to 5 min for large schools

type Params = Promise<{ schoolId: string }>;

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId } = await params;
  const started = Date.now();
  try {
    const form = await request.formData();
    const dryRun = String(form.get('dry_run') ?? '') === '1';
    const familyIdRaw = String(form.get('family_id') ?? '').trim();
    const familyIds = familyIdRaw ? [familyIdRaw] : undefined;

    const result = await promoteParent2sForSchool(schoolId, { dryRun, familyIds });
    const duration = Date.now() - started;

    const verb = dryRun ? 'DRY RUN: would promote' : 'Promoted';
    const summary =
      `${verb} ${result.promoted_now}, already ${result.already_promoted}, ` +
      `no P2 ${result.skipped_no_p2}, no P2 email ${result.skipped_no_p2_email}, ` +
      `no P1 contact ${result.skipped_no_p1_contact}, errors ${result.errors}` +
      ` (across ${result.total_families} families, ${(duration / 1000).toFixed(1)}s)`;

    // Audit log
    await query(
      `INSERT INTO widget_fetch_log (school_id, dashboard_slug, widget_id, duration_ms, error)
       VALUES ($1, '_promote_p2', $2, $3, $4)`,
      [schoolId, dryRun ? 'dry_run' : 'live', duration, summary],
    ).catch(() => undefined);

    return back(request, schoolId, { msg: summary });
  } catch (err) {
    return back(request, schoolId, {
      err: `Failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

function back(request: NextRequest, schoolId: string, q: { msg?: string; err?: string }) {
  const url = request.nextUrl.clone();
  url.pathname = `/admin/${schoolId}`;
  url.search = '';
  if (q.msg) url.searchParams.set('msg', q.msg);
  if (q.err) url.searchParams.set('err', q.err);
  url.hash = 'promote-parent2';
  return NextResponse.redirect(url, 303);
}
