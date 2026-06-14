// POST /api/admin/schools/{schoolId}/payments/bulk-facts-tuition
//
// Bulk-creates tuition enrollments + installment schedules for every
// active student that has imported FACTS data + a recognized payment
// plan, anchored to one school-chosen first payment date. The FACTS
// amount is the annual total (via the generator's tuition override), so
// the rate card doesn't have to match FACTS exactly. Autopay is on by
// default, and while the school is in dry-run every invoice is a draft —
// so this is safe to run and review before going live.
//
// Idempotent: students already on a plan for the year are skipped, so a
// re-run only fills in the rest (useful if a run is interrupted).
//
// Form fields: first_due_date (YYYY-MM-DD), amount_basis (net|remaining),
// return_to.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { generateTuitionEnrollment } from '@/lib/billing/tuition-plan-generator';
import { planFactsBulk, type AmountBasis } from '@/lib/billing/facts-bulk';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

type Params = Promise<{ schoolId: string }>;
const YEAR = '2026-27';
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
  const fd = await request.formData();
  const returnTo = String(fd.get('return_to') ?? '').trim() || undefined;
  const amountBasis: AmountBasis = String(fd.get('amount_basis') ?? 'net') === 'remaining' ? 'remaining' : 'net';
  const firstRaw = String(fd.get('first_due_date') ?? '').trim();
  const firstDueDate = /^\d{4}-\d{2}-\d{2}$/.test(firstRaw) ? firstRaw : null;
  if (!firstDueDate) return back(request, schoolId, { err: 'Pick a valid first payment date.', href: returnTo });

  try {
    const plan = await planFactsBulk(schoolId, { amountBasis, academicYear: YEAR });
    const ready = plan.rows.filter((r) => r.ready);

    // Students already scheduled for the year (plan set) — skip so re-runs
    // only fill the gaps.
    const { rows: existing } = await query<{ student_id: string }>(
      `SELECT student_id FROM family_tuition_enrollments
        WHERE school_id = $1 AND academic_year = $2 AND payment_plan_id IS NOT NULL AND student_id IS NOT NULL`,
      [schoolId, YEAR],
    );
    const done = new Set(existing.map((e) => e.student_id));

    let created = 0, skipped = 0, failed = 0;
    const errors: string[] = [];
    for (const r of ready) {
      if (done.has(r.student_id)) { skipped++; continue; }
      try {
        await generateTuitionEnrollment({
          schoolId,
          familyId: r.family_id,
          studentId: r.student_id,
          academicYear: YEAR,
          tuitionGridId: r.grid_id!,
          paymentPlanId: r.plan_id!,
          addonKeys: [],
          tuitionOverrideCents: r.amount_cents,
          tuitionOverrideReason: `Migrated from FACTS ${YEAR}`,
          firstDueDate,
          createdByEmail: 'operator@growthsuite.local',
          initialStatus: 'open',
        });
        created++;
      } catch (e) {
        failed++;
        if (errors.length < 5) errors.push(`${r.student_name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const errSuffix = failed > 0 ? ` ${failed} failed${errors.length ? ` (${errors.join('; ')})` : ''}.` : '';
    return back(request, schoolId, {
      msg: `Scheduled tuition for ${created} student${created === 1 ? '' : 's'} (first payment ${firstDueDate}).` +
        (skipped > 0 ? ` ${skipped} already scheduled — skipped.` : '') + errSuffix,
      href: returnTo,
    });
  } catch (err) {
    return back(request, schoolId, { err: `Bulk scheduling failed: ${err instanceof Error ? err.message : String(err)}`, href: returnTo });
  }
}
