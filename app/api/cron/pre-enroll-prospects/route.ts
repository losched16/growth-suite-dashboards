// Cron / manual: label new prospects "Pre-Enrolled" (see lib/sync/pre-enroll-prospects.ts).
// Scheduled runs happen inside sync-all; this route is for a dry run or a
// capped trial, and it works before the school's setting is on. `?school_id=` is
// required, `?dry_run=1` writes nothing, `?limit=N` caps the students labelled.
// Scheduled runs only happen when settings.pre_enroll_prospects = true.
//
// Auth: Bearer CRON_SECRET or INTERNAL_API_TOKEN (same as sync-all).

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { preEnrollProspects } from '@/lib/sync/pre-enroll-prospects';

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
  if (!schoolId) return NextResponse.json({ error: 'school_id required' }, { status: 400 });
  const dryRun = request.nextUrl.searchParams.get('dry_run') === '1';
  const limitRaw = Number(request.nextUrl.searchParams.get('limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
  try {
    return NextResponse.json(await preEnrollProspects(schoolId, { dryRun, limit, force: true }));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
