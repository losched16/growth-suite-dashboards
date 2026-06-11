// Cron endpoint — re-syncs every school's family-graph from GHL.
// Triggered by Vercel Cron (configured in vercel.json) and/or by an
// internal call from another service. Two auth modes:
//
//   1. Vercel Cron sets an `Authorization: Bearer <CRON_SECRET>` header
//      automatically (when CRON_SECRET is set as an env var).
//   2. Internal callers can use the same shared INTERNAL_API_TOKEN bearer
//      that all /api/v1 routes accept.
//
// Either matches → run. Neither → 401.
//
// Behavior: iterates every row in `schools` table that has a non-null
// PIT, runs runGhlSync for each, returns a summary. Failures per school
// are caught and reported in the response, never abort the whole run.

import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { runGhlSync, type SyncResult } from '@/lib/sync/run-ghl-sync';
import { syncGhlAttributes } from '@/lib/sync/ghl-attributes';

// Vercel cron may take longer than the default Hobby 10s; bump.
export const maxDuration = 300; // 5 min

interface SchoolRow {
  id: string;
  name: string;
  ghl_location_id: string;
  sync_mode: 'snapshot' | 'attributes_only' | 'off';
}

interface PerSchoolResult {
  school_id: string;
  name: string;
  location_id: string;
  ok: boolean;
  duration_ms: number;
  result?: SyncResult;
  error?: string;
}

export async function GET(request: NextRequest) {
  if (!authorize(request)) return new NextResponse('unauthorized', { status: 401 });
  return runForAll();
}

// Allow POST so callers can fire-and-forget without a body
export async function POST(request: NextRequest) {
  if (!authorize(request)) return new NextResponse('unauthorized', { status: 401 });
  return runForAll();
}

function authorize(request: NextRequest): boolean {
  const auth = request.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return false;
  const presented = auth.slice('Bearer '.length).trim();

  // Try CRON_SECRET first (what Vercel cron sends), then INTERNAL_API_TOKEN.
  const candidates = [
    process.env.CRON_SECRET,
    process.env.INTERNAL_API_TOKEN,
  ].filter((s): s is string => !!s && s.length > 0);

  for (const expected of candidates) {
    const a = Buffer.from(presented, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) continue;
    if (crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

async function runForAll(): Promise<NextResponse> {
  const started = Date.now();
  const { rows: schools } = await query<SchoolRow>(
    `SELECT id, name, ghl_location_id, COALESCE(sync_mode, 'snapshot') AS sync_mode
     FROM schools
     WHERE ghl_pit_encrypted IS NOT NULL
     ORDER BY name`,
  );

  const results: PerSchoolResult[] = [];
  let okCount = 0;
  let failCount = 0;

  for (const s of schools) {
    if (s.sync_mode === 'off') continue;
    const t0 = Date.now();
    try {
      // Snapshot mode: full destructive family-graph rebuild from GHL.
      // attributes_only mode (import-managed rosters like DGM/MCH):
      // SKIP the destructive sync — their family graph is the source of
      // truth in OUR db; only the additive attribute layer refreshes.
      const result = s.sync_mode === 'snapshot' ? await runGhlSync(s.id) : null;

      // Attribute layer (tags / custom-field values / opportunities /
      // filter catalog) refreshes for every non-off school. Additive,
      // never touches the family graph.
      let attrSummary = '';
      try {
        const attrs = await syncGhlAttributes(s.id);
        attrSummary = ` Attributes: ${attrs.tag_rows} tags, ${attrs.field_value_rows} field values, ${attrs.opportunities} opps, ${attrs.catalog_attributes} catalog.`;
      } catch (attrErr) {
        attrSummary = ` Attributes FAILED: ${attrErr instanceof Error ? attrErr.message : String(attrErr)}`;
      }

      const dur = Date.now() - t0;
      const summary = (result
        ? `Synced ${result.families_created} families, ${result.students_created} students, ${result.enrollments_created} enrollments, ${result.classrooms_created} classrooms.`
        : `Family-graph sync skipped (sync_mode=${s.sync_mode}).`) + attrSummary;
      results.push({
        school_id: s.id,
        name: s.name,
        location_id: s.ghl_location_id,
        ok: true,
        duration_ms: dur,
        result: result ?? undefined,
      });
      // Per-school audit row (so the school admin shows its own cron events)
      await query(
        `INSERT INTO widget_fetch_log (school_id, dashboard_slug, widget_id, duration_ms, error)
         VALUES ($1, '_sync', 'cron', $2, $3)`,
        [s.id, dur, summary],
      ).catch(() => undefined);
      okCount++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const dur = Date.now() - t0;
      results.push({
        school_id: s.id,
        name: s.name,
        location_id: s.ghl_location_id,
        ok: false,
        duration_ms: dur,
        error: msg,
      });
      await query(
        `INSERT INTO widget_fetch_log (school_id, dashboard_slug, widget_id, duration_ms, error)
         VALUES ($1, '_sync', 'cron', $2, $3)`,
        [s.id, dur, `FAILED: ${msg}`],
      ).catch(() => undefined);
      failCount++;
      console.error(`[cron/sync-all] ${s.name} failed:`, msg);
    }
  }

  // Persist a high-level audit row in widget_fetch_log so operators can
  // see when the cron last ran (and whether anything failed).
  try {
    await query(
      `INSERT INTO widget_fetch_log (school_id, dashboard_slug, widget_id, error)
       VALUES (NULL, '_cron', 'sync-all',
               $1)`,
      [`ok=${okCount} fail=${failCount} duration_ms=${Date.now() - started}`],
    );
  } catch {
    // swallow — audit failure can't fail the cron
  }

  return NextResponse.json({
    ok: failCount === 0,
    started_at: new Date(started).toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    schools_processed: schools.length,
    successes: okCount,
    failures: failCount,
    results,
  }, { status: failCount === 0 ? 200 : 207 /* multi-status */ });
}
