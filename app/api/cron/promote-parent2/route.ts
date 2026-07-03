// Cron-style endpoint to run promote-parent2 for one school OR every school.
// Same bearer-auth contract as /api/cron/sync-all (CRON_SECRET or
// INTERNAL_API_TOKEN). Form/query param `school_id` selects a single school;
// omitted → run for every school with a PIT. `dry_run=1` previews.
//
// Operators can still trigger this from the school admin UI via the regular
// cookie-auth route at /api/admin/schools/[id]/promote-parent2; this endpoint
// is for scripted / scheduled use.

import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { promoteParent2sForSchool, type PromoteResult } from '@/lib/sync/promote-parent2';

export const maxDuration = 300;

interface SchoolRow {
  id: string;
  name: string;
}

interface PerSchoolResult {
  school_id: string;
  name: string;
  ok: boolean;
  duration_ms: number;
  result?: PromoteResult;
  error?: string;
}

export async function GET(request: NextRequest) {
  if (!authorize(request)) return new NextResponse('unauthorized', { status: 401 });
  return run(request);
}

export async function POST(request: NextRequest) {
  if (!authorize(request)) return new NextResponse('unauthorized', { status: 401 });
  return run(request);
}

function authorize(request: NextRequest): boolean {
  const auth = request.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return false;
  const presented = auth.slice('Bearer '.length).trim();
  const candidates = [process.env.CRON_SECRET, process.env.INTERNAL_API_TOKEN]
    .filter((s): s is string => !!s && s.length > 0);
  for (const expected of candidates) {
    const a = Buffer.from(presented, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) continue;
    if (crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

async function run(request: NextRequest): Promise<NextResponse> {
  const started = Date.now();
  const schoolIdParam = request.nextUrl.searchParams.get('school_id');
  const dryRun = request.nextUrl.searchParams.get('dry_run') === '1';

  let schools: SchoolRow[];
  if (schoolIdParam) {
    const { rows } = await query<SchoolRow>(
      `SELECT id, name FROM schools WHERE id = $1 AND ghl_pit_encrypted IS NOT NULL`,
      [schoolIdParam],
    );
    schools = rows;
  } else {
    // Scheduled (all-schools) runs only touch schools that opted in via
    // settings.promote_parent2 (school Settings page). A specific school_id
    // can still be triggered on demand from the admin UI for any school.
    const { rows } = await query<SchoolRow>(
      `SELECT id, name FROM schools
        WHERE ghl_pit_encrypted IS NOT NULL
          AND settings->>'promote_parent2' = 'true'
        ORDER BY name`,
    );
    schools = rows;
  }

  const results: PerSchoolResult[] = [];
  let okCount = 0;
  let failCount = 0;

  for (const s of schools) {
    const t0 = Date.now();
    try {
      const result = await promoteParent2sForSchool(s.id, { dryRun });
      const dur = Date.now() - t0;
      results.push({ school_id: s.id, name: s.name, ok: true, duration_ms: dur, result });
      const verb = dryRun ? 'DRY RUN: would promote' : 'Promoted';
      const summary =
        `${verb} ${result.promoted_now}, already ${result.already_promoted}, ` +
        `no P2 ${result.skipped_no_p2}, no P2 email ${result.skipped_no_p2_email}, ` +
        `no P1 contact ${result.skipped_no_p1_contact}, errors ${result.errors}` +
        ` (across ${result.total_families} families)`;
      await query(
        `INSERT INTO widget_fetch_log (school_id, dashboard_slug, widget_id, duration_ms, error)
         VALUES ($1, '_promote_p2', $2, $3, $4)`,
        [s.id, dryRun ? 'dry_run_cron' : 'cron', dur, summary],
      ).catch(() => undefined);
      okCount++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const dur = Date.now() - t0;
      results.push({ school_id: s.id, name: s.name, ok: false, duration_ms: dur, error: msg });
      failCount++;
    }
  }

  return NextResponse.json({
    ok: failCount === 0,
    started_at: new Date(started).toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    dry_run: dryRun,
    schools_processed: schools.length,
    successes: okCount,
    failures: failCount,
    results,
  }, { status: failCount === 0 ? 200 : 207 });
}
