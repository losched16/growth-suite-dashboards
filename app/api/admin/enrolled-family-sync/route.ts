// Manual trigger for the enrolled-family sync (lib/sync/enrolled-family-sync).
// The cron runs it automatically for opted-in schools; this exists to
// dry-run it against live data before a school is opted in, and to force a
// run on demand.
//
//   POST /api/admin/enrolled-family-sync?school_id=<uuid>            → DRY RUN (default)
//   POST /api/admin/enrolled-family-sync?school_id=<uuid>&apply=1    → apply
//   add &force=1 to run for a school that hasn't opted in yet
//
// Bearer INTERNAL_API_TOKEN or CRON_SECRET.

import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { checkServiceAuth, unauthorizedResponse } from '@/lib/auth/service';
import { syncEnrolledFamilies } from '@/lib/sync/enrolled-family-sync';

export const maxDuration = 300;

function cronSecretOk(request: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  const auth = request.headers.get('authorization') ?? '';
  if (!expected || !auth.startsWith('Bearer ')) return false;
  const a = Buffer.from(auth.slice('Bearer '.length).trim(), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
  if (!checkServiceAuth(request) && !cronSecretOk(request)) return unauthorizedResponse();
  const params = new URL(request.url).searchParams;
  const schoolId = (params.get('school_id') ?? '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(schoolId)) {
    return NextResponse.json({ error: 'school_id (uuid) required' }, { status: 400 });
  }
  try {
    const result = await syncEnrolledFamilies(schoolId, {
      dryRun: params.get('apply') !== '1',
      force: params.get('force') === '1',
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
