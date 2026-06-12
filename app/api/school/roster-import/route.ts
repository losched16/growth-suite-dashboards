// POST /api/school/roster-import
//
// School-facing sibling of /api/admin/schools/{schoolId}/roster-import.
// Same parse → preview/apply flow, but reachable by the school itself
// from /school/{locationId}/roster-import (the self-serve upload page).
//
// Body (multipart form):
//   school_id — uuid
//   csv       — string (file contents or paste)
//   op        — 'preview' | 'apply'
//
// Auth: unlike the light embedded config endpoints, this one CREATES
// families/parents/students, so it requires a real session — an
// operator session, or a school session (staff magic-link / GHL menu
// link) for the same school. Standalone schools hit this from a
// top-level page where the cookie is reliable.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { withTransaction } from '@/lib/db';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { parseRosterCsv } from '@/lib/roster/csv-parser';
import { previewRosterImport, applyRosterImport } from '@/lib/roster/importer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  let fd: FormData;
  try { fd = await request.formData(); }
  catch { return NextResponse.json({ ok: false, error: 'invalid_form_data' }, { status: 400 }); }

  const schoolId = String(fd.get('school_id') ?? '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(schoolId)) {
    return NextResponse.json({ ok: false, error: 'school_id required' }, { status: 400 });
  }

  const ck = await cookies();
  const operatorOk = verifySessionToken(ck.get(SESSION_COOKIE)?.value);
  const schoolSession = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  const schoolOk = schoolSession !== null && schoolSession.school_id === schoolId;
  if (!operatorOk && !schoolOk) {
    return NextResponse.json({
      ok: false,
      error: 'Not signed in. Open this page from your school dashboard (or sign in again) and retry.',
    }, { status: 401 });
  }

  const op = String(fd.get('op') ?? 'preview').trim();
  const csv = String(fd.get('csv') ?? '');
  if (!csv.trim()) {
    return NextResponse.json({ ok: false, error: 'No CSV content provided.' }, { status: 400 });
  }

  const parsed = parseRosterCsv(csv);
  if (parsed.errors.length > 0 && parsed.rows.length === 0) {
    return NextResponse.json({
      ok: false,
      error: 'CSV parse failed. Fix the errors and re-upload.',
      errors: parsed.errors,
    }, { status: 400 });
  }

  if (op === 'preview') {
    const preview = await withTransaction(async (q) => {
      return previewRosterImport(schoolId, parsed.rows, q);
    });
    return NextResponse.json({ ok: true, preview, errors: parsed.errors });
  }

  if (op === 'apply') {
    if (parsed.errors.length > 0) {
      return NextResponse.json({
        ok: false,
        error: `Can't apply with ${parsed.errors.length} parse errors. Fix the CSV first.`,
        errors: parsed.errors,
      }, { status: 400 });
    }
    const result = await applyRosterImport(schoolId, parsed.rows);
    return NextResponse.json({ ok: true, result });
  }

  return NextResponse.json({ ok: false, error: `Unknown op: ${op}` }, { status: 400 });
}
