// POST /api/admin/schools/{schoolId}/roster-import
//
// Operator-only roster CSV import. Accepts a CSV body, parses, and either
// returns a preview (dry-run) or applies the import.
//
// Body (multipart form):
//   csv     — string (paste content)
//   op      — 'preview' | 'apply'
//
// Response:
//   - On preview: JSON { ok, preview, errors }
//   - On apply:   JSON { ok, result }
//   - On error:   JSON { ok: false, error }
//
// Auth: operator-gated by the proxy.ts /admin/* rule. School session
// users can't reach this endpoint.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { withTransaction } from '@/lib/db';
import { authorizeOperatorOrSchool } from '@/lib/auth/dual';
import { parseRosterCsv } from '@/lib/roster/csv-parser';
import { previewRosterImport, applyRosterImport } from '@/lib/roster/importer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Params = Promise<{ schoolId: string }>;

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId } = await params;
  const _auth = await authorizeOperatorOrSchool(schoolId);
  if (!_auth.ok) return _auth.response;

  let fd: FormData;
  try { fd = await request.formData(); }
  catch { return NextResponse.json({ ok: false, error: 'invalid_form_data' }, { status: 400 }); }

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
