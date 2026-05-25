// POST /api/admin/schools/{schoolId}/payments/plans
//
// CRUD for payment_plans templates.
//   op=add     | new plan
//   op=update  | edit existing plan
//   op=delete  | deactivate
//   op=seed_defaults | inserts the 4 standard templates (annual, 2-pay,
//                     4-pay, 10-pay) for schools just starting out

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { authorizeOperatorOrSchool } from '@/lib/auth/dual';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string }>;

// Where to send the user after the POST. Defaults to the operator
// payments page; school-iframe callers pass a `return_to` form field
// pointing at /school/{locationId}/payments?tab=plans so the operator
// stays inside the GHL embed. We reject anything that isn't a path
// rooted at /admin/ or /school/ to avoid open-redirects.
function safeReturn(returnTo: string | null, schoolId: string): string {
  if (returnTo && /^\/(admin|school)\//.test(returnTo) && !returnTo.includes('://')) {
    return returnTo;
  }
  return `/admin/${schoolId}/payments`;
}

function back(
  request: NextRequest,
  schoolId: string,
  q: { msg?: string; err?: string; returnTo?: string | null },
) {
  const url = request.nextUrl.clone();
  url.pathname = safeReturn(q.returnTo ?? null, schoolId);
  url.search = '';
  if (q.msg) url.searchParams.set('msg', q.msg);
  if (q.err) url.searchParams.set('err', q.err);
  return NextResponse.redirect(url, 303);
}

// Build a schedule_template JSON based on the installment_count + a
// shorthand kind. For Phase 1b we support these kinds:
//   single        — one annual payment
//   semiannual    — two equal payments (Aug + Jan default)
//   quarterly     — four equal payments (Aug, Nov, Feb, May)
//   monthly_10    — Aug through May, the 10 instructional months
//   monthly_12    — every month of the year
function defaultScheduleFor(slug: string, installmentCount: number): Record<string, unknown> {
  if (installmentCount === 1) return { kind: 'single' };
  if (installmentCount === 2) return { kind: 'semiannual', months: ['08', '01'] };
  if (installmentCount === 4) return { kind: 'quarterly', months: ['08', '11', '02', '05'] };
  if (installmentCount === 10) return { kind: 'monthly_10', months: ['08','09','10','11','12','01','02','03','04','05'] };
  if (installmentCount === 12) return { kind: 'monthly_12', months: ['08','09','10','11','12','01','02','03','04','05','06','07'] };
  return { kind: 'custom', installments: installmentCount };
}

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId } = await params;
  const auth = await authorizeOperatorOrSchool(schoolId);
  if (!auth.ok) return auth.response;

  const fd = await request.formData();
  const op = String(fd.get('op') ?? '').trim();
  const returnTo = String(fd.get('return_to') ?? '') || null;

  try {
    if (op === 'seed_defaults') {
      const defaults = [
        { slug: 'annual', display: 'Annual (single payment)', count: 1, discount_bp: 250, desc: 'Pay once at the start of the year. 2.5% discount applied.' },
        { slug: 'semiannual', display: '2 Payments (Aug + Jan)', count: 2, discount_bp: 0, desc: 'Half due in August, half due in January.' },
        { slug: 'quarterly', display: '4 Payments (Quarterly)', count: 4, discount_bp: 0, desc: 'Four equal payments through the school year.' },
        { slug: 'monthly_10', display: '10 Monthly Payments', count: 10, discount_bp: 0, desc: 'Equal monthly payments August through May.' },
      ];
      for (let i = 0; i < defaults.length; i++) {
        const d = defaults[i];
        await query(
          `INSERT INTO payment_plans
             (school_id, slug, display_name, description, installment_count,
              discount_basis_points, schedule_template, is_active, position)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, true, $8)
           ON CONFLICT (school_id, slug) DO NOTHING`,
          [schoolId, d.slug, d.display, d.desc, d.count, d.discount_bp,
           JSON.stringify(defaultScheduleFor(d.slug, d.count)), i],
        );
      }
      return back(request, schoolId, { msg: 'Seeded 4 default payment plans.', returnTo });
    }

    if (op === 'add') {
      const slug = String(fd.get('slug') ?? '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
      const displayName = String(fd.get('display_name') ?? '').trim();
      const description = String(fd.get('description') ?? '').trim() || null;
      const installmentCount = parseInt(String(fd.get('installment_count') ?? '1'), 10);
      const discountPct = parseFloat(String(fd.get('discount_pct') ?? '0'));
      const discountBp = Math.round(Math.max(0, discountPct) * 100);
      if (!slug || !displayName || !(installmentCount >= 1)) {
        return back(request, schoolId, { err: 'Slug, name, and installment count are required.', returnTo });
      }
      await query(
        `INSERT INTO payment_plans
           (school_id, slug, display_name, description, installment_count,
            discount_basis_points, schedule_template, is_active, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, true,
                 (SELECT COALESCE(MAX(position), 0) + 1 FROM payment_plans WHERE school_id = $1))`,
        [schoolId, slug, displayName, description, installmentCount, discountBp,
         JSON.stringify(defaultScheduleFor(slug, installmentCount))],
      );
      return back(request, schoolId, { msg: `Added "${displayName}" payment plan.`, returnTo });
    }

    if (op === 'update') {
      const id = String(fd.get('id') ?? '');
      const displayName = String(fd.get('display_name') ?? '').trim();
      const description = String(fd.get('description') ?? '').trim() || null;
      const discountPct = parseFloat(String(fd.get('discount_pct') ?? '0'));
      const discountBp = Math.round(Math.max(0, discountPct) * 100);
      const isActive = fd.get('is_active') === '1';
      await query(
        `UPDATE payment_plans
            SET display_name = $1, description = $2,
                discount_basis_points = $3, is_active = $4,
                updated_at = now()
          WHERE id = $5 AND school_id = $6`,
        [displayName, description, discountBp, isActive, id, schoolId],
      );
      return back(request, schoolId, { msg: `Updated "${displayName}".`, returnTo });
    }

    if (op === 'delete') {
      const id = String(fd.get('id') ?? '');
      await query(
        `UPDATE payment_plans SET is_active = false, updated_at = now() WHERE id = $1 AND school_id = $2`,
        [id, schoolId],
      );
      return back(request, schoolId, { msg: 'Deactivated plan.', returnTo });
    }

    return back(request, schoolId, { err: `Unknown op: ${op}`, returnTo });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return back(request, schoolId, { err: `Save failed: ${msg}`, returnTo });
  }
}
