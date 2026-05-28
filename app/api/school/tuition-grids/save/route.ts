// POST /api/school/tuition-grids/save
//
// School-iframe CRUD for tuition_grids. Replaces the per-school custom
// seed scripts (seed-mch-tuition.mjs, _reseed_dgm_tuition.mjs, etc.) for
// day-to-day grid management. School session auth — same model as the
// rest of /api/school/*.
//
// Body (form-encoded):
//   op = 'add' | 'update' | 'deactivate' | 'reactivate'
//   plus the relevant fields per op.
//
// On success: 303 redirect to return_to (or default) with ?msg=…
// On error:   303 redirect with ?err=…

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function bounce(request: NextRequest, returnTo: string | null, qs: { msg?: string; err?: string }) {
  const fallback = '/school/_/payments?tab=grids';
  const base = returnTo && /^\/school\/[A-Za-z0-9_-]+\//.test(returnTo) ? returnTo : fallback;
  const url = new URL(base, request.url);
  if (qs.msg) url.searchParams.set('msg', qs.msg);
  if (qs.err) url.searchParams.set('err', qs.err);
  return NextResponse.redirect(url, 303);
}

function dollarsToCents(raw: string): number {
  const n = parseFloat(String(raw).replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}

export async function POST(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let fd: FormData;
  try { fd = await request.formData(); }
  catch { return NextResponse.json({ error: 'invalid_form_data' }, { status: 400 }); }

  const op = String(fd.get('op') ?? '').trim();
  const returnTo = String(fd.get('return_to') ?? '').trim() || null;

  try {
    if (op === 'add') {
      const academicYear = String(fd.get('academic_year') ?? '').trim();
      const program      = String(fd.get('program') ?? '').trim();
      const gradeLevel   = String(fd.get('grade_level') ?? '').trim();
      const displayName  = String(fd.get('display_name') ?? '').trim();
      const annualCents  = dollarsToCents(String(fd.get('annual_tuition_dollars') ?? ''));
      const position     = Math.max(0, parseInt(String(fd.get('position') ?? '0'), 10) || 0);

      if (!academicYear || !/^\d{4}-\d{2}$/.test(academicYear)) {
        return bounce(request, returnTo, { err: 'Academic year is required in format YYYY-YY (e.g. 2026-27).' });
      }
      if (!program)     return bounce(request, returnTo, { err: 'Program is required (e.g. "YC — 5 Days, Full Day").' });
      if (!gradeLevel)  return bounce(request, returnTo, { err: 'Grade level is required (e.g. "Young Community", "Primary", "Kindergarten").' });
      if (!displayName) return bounce(request, returnTo, { err: 'Display name is required.' });
      if (annualCents <= 0) return bounce(request, returnTo, { err: 'Annual tuition must be greater than $0.' });

      // The table has a UNIQUE constraint on (school_id, academic_year,
      // program, grade_level). Catch that as a friendly error.
      try {
        await query(
          `INSERT INTO tuition_grids
             (school_id, academic_year, program, grade_level, display_name,
              annual_tuition_cents, addons, is_active, position)
           VALUES ($1, $2, $3, $4, $5, $6, '[]'::jsonb, true, $7)`,
          [session.school_id, academicYear, program, gradeLevel, displayName, annualCents, position],
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('tuition_grids') && msg.includes('unique')) {
          return bounce(request, returnTo, {
            err: `A grid with this Program + Grade Level already exists for ${academicYear}. Pick a different program/grade combo.`,
          });
        }
        throw e;
      }
      return bounce(request, returnTo, {
        msg: `Created grid "${displayName}" at $${(annualCents / 100).toLocaleString()} annual.`,
      });
    }

    if (op === 'update') {
      const id = String(fd.get('id') ?? '').trim();
      if (!id) return bounce(request, returnTo, { err: 'Missing grid id.' });
      const displayName = String(fd.get('display_name') ?? '').trim();
      const annualCents = dollarsToCents(String(fd.get('annual_tuition_dollars') ?? ''));
      const position    = Math.max(0, parseInt(String(fd.get('position') ?? '0'), 10) || 0);
      if (!displayName) return bounce(request, returnTo, { err: 'Display name is required.' });
      if (annualCents <= 0) return bounce(request, returnTo, { err: 'Annual tuition must be greater than $0.' });

      await query(
        `UPDATE tuition_grids
            SET display_name = $1, annual_tuition_cents = $2, position = $3, updated_at = now()
          WHERE id = $4 AND school_id = $5`,
        [displayName, annualCents, position, id, session.school_id],
      );
      return bounce(request, returnTo, { msg: `Updated grid "${displayName}".` });
    }

    if (op === 'deactivate') {
      const id = String(fd.get('id') ?? '').trim();
      if (!id) return bounce(request, returnTo, { err: 'Missing grid id.' });
      // Soft-delete to preserve the FK from family_tuition_enrollments.
      await query(
        `UPDATE tuition_grids SET is_active = false, updated_at = now()
          WHERE id = $1 AND school_id = $2`,
        [id, session.school_id],
      );
      return bounce(request, returnTo, { msg: 'Grid deactivated. Existing enrollments still reference it; new enrollments can\'t pick it.' });
    }

    if (op === 'reactivate') {
      const id = String(fd.get('id') ?? '').trim();
      if (!id) return bounce(request, returnTo, { err: 'Missing grid id.' });
      await query(
        `UPDATE tuition_grids SET is_active = true, updated_at = now()
          WHERE id = $1 AND school_id = $2`,
        [id, session.school_id],
      );
      return bounce(request, returnTo, { msg: 'Grid reactivated.' });
    }

    return bounce(request, returnTo, { err: `Unknown op: ${op}` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return bounce(request, returnTo, { err: msg });
  }
}
