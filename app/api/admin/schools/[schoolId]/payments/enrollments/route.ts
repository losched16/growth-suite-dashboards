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
import { authorizeOperatorOrSchool } from '@/lib/auth/dual';
import { generateTuitionEnrollment } from '@/lib/billing/tuition-plan-generator';
import { loadAddonCatalog, resolveAddon, type ResolvedAddon } from '@/lib/billing/addon-catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60; // installment generation hits the DB many times

type Params = Promise<{ schoolId: string }>;

// Allow redirecting back into either namespace. href may carry a query
// string (e.g. the embedded "?tab=plans"); we preserve it and append
// msg/err on top.
const SAFE_PATH = /^\/(admin|school)\/[A-Za-z0-9_-]+(\/[^?#]*)?(\?[^#]*)?$/;
function back(request: NextRequest, schoolId: string, q: { msg?: string; err?: string; href?: string }) {
  const url = request.nextUrl.clone();
  const target = q.href && SAFE_PATH.test(q.href) ? q.href : `/admin/${schoolId}/payments`;
  const [path, qs] = target.split('?');
  url.pathname = path;
  url.search = qs ? `?${qs}` : '';
  if (q.msg) url.searchParams.set('msg', q.msg);
  if (q.err) url.searchParams.set('err', q.err);
  return NextResponse.redirect(url, 303);
}

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId } = await params;
  const _auth = await authorizeOperatorOrSchool(schoolId);
  if (!_auth.ok) return _auth.response;
  const fd = await request.formData();
  const op = String(fd.get('op') ?? 'create').trim();
  // Where to bounce back after handling — keeps the operator inside the
  // embedded /school iframe when the form supplies it.
  const returnTo = String(fd.get('return_to') ?? '').trim() || undefined;

  try {
    if (op === 'cancel') {
      const id = String(fd.get('enrollment_id') ?? '').trim();
      if (!id) return back(request, schoolId, { err: 'Missing enrollment_id', href: returnTo });
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
      return back(request, schoolId, { msg: 'Enrollment cancelled and unpaid invoices voided.', href: returnTo });
    }

    // op === 'create' (or default)
    const familyId = String(fd.get('family_id') ?? '').trim();
    const studentIdRaw = String(fd.get('student_id') ?? '').trim();
    const studentId = studentIdRaw || null;
    const academicYear = String(fd.get('academic_year') ?? '').trim();
    const tuitionGridId = String(fd.get('tuition_grid_id') ?? '').trim();
    const paymentPlanId = String(fd.get('payment_plan_id') ?? '').trim();
    const addonKeys = fd.getAll('addon_keys').map(String).filter(Boolean);
    // Rate-card add-ons selected in the builder (extended care / deposit /
    // dev fee). Amounts are re-resolved from the school's catalog server-side
    // so a tampered POST can't set an arbitrary price; unknown ids drop out.
    const catalog = await loadAddonCatalog(schoolId);
    const extraAddons: ResolvedAddon[] = [
      resolveAddon(catalog, 'extended_care', String(fd.get('extended_care_id') ?? '').trim()),
      resolveAddon(catalog, 'deposit', String(fd.get('deposit_id') ?? '').trim()),
      resolveAddon(catalog, 'development_fee', String(fd.get('development_fee_id') ?? '').trim()),
    ].filter((a): a is ResolvedAddon => a !== null);
    const internalNote = String(fd.get('internal_note') ?? '').trim() || undefined;
    const initialStatus = fd.get('initial_status') === 'draft' ? 'draft' : 'open';
    // School-chosen date the first tuition installment drafts (anchors
    // the whole schedule). Optional 'YYYY-MM-DD'.
    const firstDueRaw = String(fd.get('first_due_date') ?? '').trim();
    const firstDueDate = /^\d{4}-\d{2}-\d{2}$/.test(firstDueRaw) ? firstDueRaw : null;

    if (!familyId)       return back(request, schoolId, { err: 'Family is required', href: returnTo });
    if (!academicYear)   return back(request, schoolId, { err: 'Academic year is required', href: returnTo });
    if (!tuitionGridId)  return back(request, schoolId, { err: 'Grade / tuition is required', href: returnTo });

    // No payment frequency chosen → record the enrollment + contracted
    // tuition with NO plan, so the parent picks the frequency later (in
    // their enrollment agreement / portal). No invoices materialize yet
    // — they generate when the plan is locked in. The enrollment still
    // appears in the Plans tab so staff can see who's awaiting a plan.
    if (!paymentPlanId) {
      const { rows: gridRows } = await query<{
        annual_tuition_cents: number; display_name: string;
        addons: Array<{ key: string; label: string; amount_cents: number; required?: boolean }> | null;
      }>(
        `SELECT annual_tuition_cents, display_name, addons
           FROM tuition_grids WHERE id = $1 AND school_id = $2 AND is_active = true`,
        [tuitionGridId, schoolId],
      );
      const grid = gridRows[0];
      if (!grid) return back(request, schoolId, { err: 'Grade / tuition not found or inactive', href: returnTo });

      const available = Array.isArray(grid.addons) ? grid.addons : [];
      const keySet = new Set(addonKeys);
      for (const a of available) if (a.required) keySet.add(a.key);
      const selectedAddons = [
        ...available
          .filter((a) => keySet.has(a.key))
          .map((a) => ({ key: a.key, label: a.label, amount_cents: a.amount_cents })),
        // Catalog-selected add-ons (extended care / deposit / dev fee) so the
        // contracted total is right even before the parent picks a frequency.
        ...extraAddons,
      ];
      const addonTotal = selectedAddons.reduce((s, a) => s + a.amount_cents, 0);
      const total = grid.annual_tuition_cents + addonTotal;

      await query(
        `INSERT INTO family_tuition_enrollments
           (school_id, family_id, student_id, academic_year,
            tuition_grid_id, payment_plan_id,
            annual_tuition_cents, plan_discount_basis_points, addons,
            total_annual_cents, installment_count, schedule,
            status, internal_note, created_by_email, first_due_date)
         VALUES ($1,$2,$3,$4,$5,NULL,$6,0,$7::jsonb,$8,0,NULL,'active',$9,$10,$11)
         ON CONFLICT (school_id, family_id, student_id, academic_year)
         DO UPDATE SET
           tuition_grid_id = EXCLUDED.tuition_grid_id,
           payment_plan_id = NULL,
           annual_tuition_cents = EXCLUDED.annual_tuition_cents,
           plan_discount_basis_points = 0,
           addons = EXCLUDED.addons,
           total_annual_cents = EXCLUDED.total_annual_cents,
           installment_count = 0,
           schedule = NULL,
           status = 'active',
           internal_note = COALESCE(EXCLUDED.internal_note, family_tuition_enrollments.internal_note),
           first_due_date = EXCLUDED.first_due_date,
           updated_at = now()`,
        [
          schoolId, familyId, studentId, academicYear,
          tuitionGridId, grid.annual_tuition_cents,
          JSON.stringify(selectedAddons), total,
          internalNote ?? null, 'operator@growthsuite.local', firstDueDate,
        ],
      );
      return back(request, schoolId, {
        msg: `Enrollment created — ${grid.display_name} at $${(total / 100).toLocaleString()}/yr. The parent chooses their payment frequency in their enrollment agreement.`,
        href: returnTo,
      });
    }

    const result = await generateTuitionEnrollment({
      schoolId,
      familyId,
      studentId,
      academicYear,
      tuitionGridId,
      paymentPlanId,
      addonKeys,
      extraAddons,
      internalNote,
      createdByEmail: 'operator@growthsuite.local',
      initialStatus,
      firstDueDate,
    });

    return back(request, schoolId, {
      msg: `Enrollment created. Generated ${result.invoice_ids.length} installment${result.invoice_ids.length === 1 ? '' : 's'} totaling $${(result.total_annual_cents / 100).toFixed(2)}.`,
      href: returnTo,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[enrollments] failed:', msg);
    return back(request, schoolId, { err: `Could not set up plan: ${msg}`, href: returnTo });
  }
}
