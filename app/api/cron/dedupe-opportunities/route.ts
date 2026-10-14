// Cron: collapse duplicate pipeline cards for the same student (see
// lib/sync/dedupe-opportunities.ts). Scheduled runs touch only schools with
// settings.dedupe_partial_opportunities = true; `?school_id=` targets one
// school regardless of the flag, `?dry_run=1` previews.
//
// Auth: Bearer CRON_SECRET or INTERNAL_API_TOKEN (same as sync-all).

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { query } from '@/lib/db';
import { dedupePartialOpportunities } from '@/lib/sync/dedupe-opportunities';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

function authorize(request: NextRequest): boolean {
  const auth = request.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return false;
  const presented = Buffer.from(auth.slice('Bearer '.length).trim(), 'utf8');
  for (const expected of [process.env.CRON_SECRET, process.env.INTERNAL_API_TOKEN]) {
    if (!expected) continue;
    const b = Buffer.from(expected, 'utf8');
    if (presented.length === b.length && crypto.timingSafeEqual(presented, b)) return true;
  }
  return false;
}

async function run(request: NextRequest) {
  if (!authorize(request)) return new NextResponse('unauthorized', { status: 401 });
  const schoolId = request.nextUrl.searchParams.get('school_id');
  const dryRun = request.nextUrl.searchParams.get('dry_run') === '1';
  const { rows: schools } = await query<{ id: string; name: string }>(
    schoolId
      ? `SELECT id, name FROM schools WHERE id = $1 AND ghl_pit_encrypted IS NOT NULL`
      : `SELECT id, name FROM schools
          WHERE ghl_pit_encrypted IS NOT NULL
            AND settings->>'dedupe_partial_opportunities' = 'true'`,
    schoolId ? [schoolId] : [],
  );
  const results = [];
  for (const s of schools) {
    try {
      results.push({ school: s.name, ok: true, ...(await dedupePartialOpportunities(s.id, { dryRun })) });
    } catch (err) {
      results.push({ school: s.name, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return NextResponse.json({ dry_run: dryRun, results });
}

export const GET = run;
export const POST = run;
