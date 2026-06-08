// POST /api/school/sync-from-ghl
//
// School-iframe-friendly version of /api/admin/schools/{schoolId}/sync-from-ghl.
// Same underlying behavior (runGhlSync with snapshot semantics) but:
//   1) Auth via school session cookie (operators inside the iframe), not
//      the cross-school operator cookie — school staff can refresh
//      THEIR OWN data without needing operator credentials.
//   2) Redirects back to the school iframe URL the form was posted from
//      (return_to), not the operator /admin/ page, so the operator never
//      sees a 401 / wrong-tenant landing.
//
// Use case: an operator just edited a contact in GHL (e.g. fixed a
// last-name typo) and wants the Family Hub to show the change right
// now instead of waiting for the daily cron. The button on the Family
// Hub widget header posts here.
//
// Idempotent — re-running the sync mid-flight is harmless (snapshot
// semantics + transactional). Typical runtime: 10-60s for 50-300
// families, longer for larger tenants.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { runGhlSync } from '@/lib/sync/run-ghl-sync';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

function bounce(
  request: NextRequest,
  returnTo: string | null,
  qs: { msg?: string; err?: string },
) {
  const fallback = '/school/_/family-hub';
  const base = returnTo && /^\/school\/[A-Za-z0-9_-]+\//.test(returnTo) ? returnTo : fallback;
  const url = new URL(base, request.url);
  if (qs.msg) url.searchParams.set('msg', qs.msg);
  if (qs.err) url.searchParams.set('err', qs.err);
  return NextResponse.redirect(url, 303);
}

export async function POST(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let fd: FormData;
  try { fd = await request.formData(); }
  catch { fd = new FormData(); }
  const returnTo = String(fd.get('return_to') ?? '').trim() || null;

  const started = Date.now();
  try {
    const r = await runGhlSync(session.school_id);
    const duration = Date.now() - started;

    // Short, human-readable summary for the page flash. Compresses
    // runGhlSync's full result (which has many counters) down to what
    // an operator cares about in this context: what changed + how long.
    const summary = `Synced from GHL in ${Math.round(duration / 1000)}s — ${r.families_created} families, ${r.students_created} students refreshed.${r.warnings.length ? ` ${r.warnings.length} warning(s).` : ''}`;

    await query(
      `INSERT INTO widget_fetch_log (school_id, dashboard_slug, widget_id, duration_ms, error)
       VALUES ($1, '_sync', 'manual_school', $2, $3)`,
      [session.school_id, duration, summary],
    ).catch(() => undefined);

    return bounce(request, returnTo, { msg: summary });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await query(
      `INSERT INTO widget_fetch_log (school_id, dashboard_slug, widget_id, duration_ms, error)
       VALUES ($1, '_sync', 'manual_school', $2, $3)`,
      [session.school_id, Date.now() - started, `FAILED: ${msg}`],
    ).catch(() => undefined);
    return bounce(request, returnTo, { err: `Sync failed: ${msg.slice(0, 200)}` });
  }
}
