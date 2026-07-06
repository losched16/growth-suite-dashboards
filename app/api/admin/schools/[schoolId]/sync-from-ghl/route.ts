// One-shot sync from GHL into family-graph for a single school.
// Form-handler endpoint: cookie-auth via proxy.ts. POSTs back to admin
// page with success/error message. See lib/sync/run-ghl-sync.ts for
// behavior — snapshot semantics, transactional.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { runGhlSync } from '@/lib/sync/run-ghl-sync';
import { query } from '@/lib/db';
import { authorizeOperatorOrSchool } from '@/lib/auth/dual';

export const maxDuration = 60;

type Params = Promise<{ schoolId: string }>;

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId } = await params;
  const _auth = await authorizeOperatorOrSchool(schoolId);
  if (!_auth.ok) return _auth.response;
  const started = Date.now();
  try {
    const r = await runGhlSync(schoolId);
    const duration = Date.now() - started;
    const carry = r.p2_contact_ids_carried_forward > 0
      ? ` Preserved ${r.p2_contact_ids_carried_forward} Parent 2 GHL contact links.`
      : '';
    const summary = `Synced ${r.families_created} families (${r.prospective_families_created} prospective from ${r.opportunities_scanned} opps in ${r.pipelines_scanned} pipelines), ${r.students_created} students, ${r.enrollments_created} enrollments, ${r.classrooms_created} classrooms — from ${r.ghl_contacts_with_household_id} of ${r.ghl_contacts_scanned} GHL contacts.${carry}${r.warnings.length ? ` ${r.warnings.length} warning(s).` : ''}`;

    await query(
      `INSERT INTO widget_fetch_log (school_id, dashboard_slug, widget_id, duration_ms, error)
       VALUES ($1, '_sync', 'manual', $2, $3)`,
      [schoolId, duration, summary],
    ).catch(() => undefined);

    return redirectBack(request, schoolId, { msg: summary });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await query(
      `INSERT INTO widget_fetch_log (school_id, dashboard_slug, widget_id, duration_ms, error)
       VALUES ($1, '_sync', 'manual', $2, $3)`,
      [schoolId, Date.now() - started, `FAILED: ${msg}`],
    ).catch(() => undefined);
    return redirectBack(request, schoolId, { err: `Sync failed: ${msg}` });
  }
}

function redirectBack(
  request: NextRequest,
  schoolId: string,
  query: { msg?: string; err?: string },
) {
  const url = request.nextUrl.clone();
  url.pathname = `/admin/${schoolId}`;
  url.search = '';
  if (query.msg) url.searchParams.set('msg', query.msg);
  if (query.err) url.searchParams.set('err', query.err);
  return NextResponse.redirect(url, 303);
}
