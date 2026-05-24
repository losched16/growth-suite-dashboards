// POST /api/admin/schools/{schoolId}/payments/tuition-grids
//
// Form-handler CRUD endpoint for tuition_grids. Supports method
// override via `_method` form field:
//   op=add     | adds a new tuition grid row
//   op=update  | updates an existing row (requires id)
//   op=delete  | soft-deactivates (is_active=false) an existing row
//
// All redirects land back at /admin/{schoolId}/payments with a msg/err.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string }>;

function back(request: NextRequest, schoolId: string, q: { msg?: string; err?: string }) {
  const url = request.nextUrl.clone();
  url.pathname = `/admin/${schoolId}/payments`;
  url.search = '';
  if (q.msg) url.searchParams.set('msg', q.msg);
  if (q.err) url.searchParams.set('err', q.err);
  return NextResponse.redirect(url, 303);
}

function dollarsToCents(raw: string): number {
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId } = await params;
  const fd = await request.formData();
  const op = String(fd.get('op') ?? '').trim();

  try {
    if (op === 'add') {
      const academicYear = String(fd.get('academic_year') ?? '').trim() || '2026-27';
      const program = String(fd.get('program') ?? '').trim();
      const gradeLevel = String(fd.get('grade_level') ?? '').trim() || null;
      const displayName = String(fd.get('display_name') ?? '').trim() || program;
      const annualTuition = dollarsToCents(String(fd.get('annual_tuition') ?? ''));
      if (!program) return back(request, schoolId, { err: 'Program is required.' });
      if (annualTuition <= 0) return back(request, schoolId, { err: 'Annual tuition must be greater than $0.' });

      await query(
        `INSERT INTO tuition_grids
           (school_id, academic_year, program, grade_level, display_name,
            annual_tuition_cents, addons, is_active, position)
         VALUES ($1, $2, $3, $4, $5, $6, '[]'::jsonb, true,
                 (SELECT COALESCE(MAX(position), 0) + 1 FROM tuition_grids WHERE school_id = $1 AND academic_year = $2))
         ON CONFLICT (school_id, academic_year, program, grade_level) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           annual_tuition_cents = EXCLUDED.annual_tuition_cents,
           is_active = true,
           updated_at = now()`,
        [schoolId, academicYear, program, gradeLevel, displayName, annualTuition],
      );
      return back(request, schoolId, { msg: `Added tuition grid for ${displayName}.` });
    }

    if (op === 'update') {
      const id = String(fd.get('id') ?? '');
      if (!id) return back(request, schoolId, { err: 'Missing id.' });
      const displayName = String(fd.get('display_name') ?? '').trim();
      const annualTuition = dollarsToCents(String(fd.get('annual_tuition') ?? ''));
      const isActive = fd.get('is_active') === '1';
      await query(
        `UPDATE tuition_grids
            SET display_name = $1,
                annual_tuition_cents = $2,
                is_active = $3,
                updated_at = now()
          WHERE id = $4 AND school_id = $5`,
        [displayName, annualTuition, isActive, id, schoolId],
      );
      return back(request, schoolId, { msg: `Updated ${displayName || 'row'}.` });
    }

    if (op === 'delete') {
      const id = String(fd.get('id') ?? '');
      if (!id) return back(request, schoolId, { err: 'Missing id.' });
      await query(
        `UPDATE tuition_grids SET is_active = false, updated_at = now()
          WHERE id = $1 AND school_id = $2`,
        [id, schoolId],
      );
      return back(request, schoolId, { msg: 'Deactivated.' });
    }

    return back(request, schoolId, { err: `Unknown op: ${op}` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return back(request, schoolId, { err: `Save failed: ${msg}` });
  }
}
