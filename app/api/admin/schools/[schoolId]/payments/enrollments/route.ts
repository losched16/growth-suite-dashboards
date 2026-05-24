// POST /api/admin/schools/{schoolId}/payments/enrollments
//
// Operator: set up a family on a tuition plan for an academic year.
// Calls the generator which:
//   1. Upserts family_tuition_enrollments
//   2. Materializes N invoices (one per installment) with correct due
//      dates from the plan's schedule
//   3. Applies discount policies (sibling, FA, etc.) against each
//
// Form fields:
//   op = 'create' | 'cancel'
//   create: family_id, student_id (optional), academic_year,
//           tuition_grid_id, payment_plan_id, addon_keys[] (multi),
//           internal_note, initial_status ('open' | 'draft')
//   cancel: enrollment_id

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { generateTuitionEnrollment } from '@/lib/billing/tuition-plan-generator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60; // installment generation hits the DB many times

type Params = Promise<{ schoolId: string }>;

function back(request: NextRequest, schoolId: string, q: { msg?: string; err?: string; href?: string }) {
  const url = request.nextUrl.clone();
  url.pathname = q.href ?? `/admin/${schoolId}/payments`;
  url.search = '';
  if (q.msg) url.searchParams.set('msg', q.msg);
  if (q.err) url.searchParams.set('err', q.err);
  return NextResponse.redirect(url, 303);
}

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId } = await params;
  const fd = await request.formData();
  const op = String(fd.get('op') ?? 'create').trim();

  try {
    if (op === 'cancel') {
      const id = String(fd.get('enrollment_id') ?? '').trim();
      if (!id) return back(request, schoolId, { err: 'Missing enrollment_id' });
      await query(
        `UPDATE family_tuition_enrollments
            SET status = 'cancelled', updated_at = now()
          WHERE id = $1 AND school_id = $2`,
        [id, schoolId],
      );
      // Void any open/draft invoices for this enrollment that haven't been paid.
      await query(
        `UPDATE invoices
            SET status = 'voided', voided_at = now(),
                voided_reason = 'Enrollment cancelled', updated_at = now()
          WHERE school_id = $1
            AND source = 'tuition_plan'
            AND source_ref->>'enrollment_id' = $2
            AND status IN ('draft', 'open')
            AND amount_paid_cents = 0`,
        [schoolId, id],
      );
      return back(request, schoolId, { msg: 'Enrollment cancelled and unpaid invoices voided.' });
    }

    // op === 'create' (or default)
    const familyId = String(fd.get('family_id') ?? '').trim();
    const studentIdRaw = String(fd.get('student_id') ?? '').trim();
    const studentId = studentIdRaw || null;
    const academicYear = String(fd.get('academic_year') ?? '').trim();
    const tuitionGridId = String(fd.get('tuition_grid_id') ?? '').trim();
    const paymentPlanId = String(fd.get('payment_plan_id') ?? '').trim();
    const addonKeys = fd.getAll('addon_keys').map(String).filter(Boolean);
    const internalNote = String(fd.get('internal_note') ?? '').trim() || undefined;
    const initialStatus = fd.get('initial_status') === 'draft' ? 'draft' : 'open';

    if (!familyId)       return back(request, schoolId, { err: 'Family is required' });
    if (!academicYear)   return back(request, schoolId, { err: 'Academic year is required' });
    if (!tuitionGridId)  return back(request, schoolId, { err: 'Tuition grid is required' });
    if (!paymentPlanId)  return back(request, schoolId, { err: 'Payment plan is required' });

    const result = await generateTuitionEnrollment({
      schoolId,
      familyId,
      studentId,
      academicYear,
      tuitionGridId,
      paymentPlanId,
      addonKeys,
      internalNote,
      createdByEmail: 'operator@growthsuite.local',
      initialStatus,
    });

    return back(request, schoolId, {
      msg: `Enrollment created. Generated ${result.invoice_ids.length} installment${result.invoice_ids.length === 1 ? '' : 's'} totaling $${(result.total_annual_cents / 100).toFixed(2)}.`,
      href: `/admin/${schoolId}/payments`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[enrollments] failed:', msg);
    return back(request, schoolId, { err: `Could not set up plan: ${msg}` });
  }
}
