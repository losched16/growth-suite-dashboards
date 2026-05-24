// POST /api/admin/schools/{schoolId}/payments/discounts
//
// Operator-only CRUD for the school's discount_policies rows.
//
// Body (form-encoded):
//   op = 'add' | 'update' | 'delete' | 'toggle_active'
//   plus the relevant fields for the op.
//
// On success: 303-redirects back to /admin/{schoolId}/payments with a
// ?msg=... toast (or ?err=... on failure).

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
function pctToBp(raw: string): number {
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(10000, Math.round(n * 100));
}
function maybe<T>(v: T | undefined | '' | null): T | null {
  if (v === '' || v === undefined || v === null) return null;
  return v;
}

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId } = await params;

  let fd: FormData;
  try { fd = await request.formData(); }
  catch { return back(request, schoolId, { err: 'Invalid form data' }); }

  const op = String(fd.get('op') ?? '').trim();

  try {
    if (op === 'add') {
      const kind = String(fd.get('kind') ?? '').trim();
      if (!['auto', 'code', 'financial_aid'].includes(kind)) {
        return back(request, schoolId, { err: 'Invalid kind' });
      }
      const displayName = String(fd.get('display_name') ?? '').trim();
      if (!displayName) return back(request, schoolId, { err: 'Display name required' });

      const percentRaw = String(fd.get('percentage_pct') ?? '').trim();
      const amountRaw = String(fd.get('amount_dollars') ?? '').trim();
      const percentageBp = percentRaw ? pctToBp(percentRaw) : 0;
      const amountCents = amountRaw ? dollarsToCents(amountRaw) : 0;
      if (percentageBp === 0 && amountCents === 0) {
        return back(request, schoolId, { err: 'Must set either percent or flat amount' });
      }
      const maxRaw = String(fd.get('max_discount_dollars') ?? '').trim();
      const maxCents = maxRaw ? dollarsToCents(maxRaw) : null;

      const code = String(fd.get('redemption_code') ?? '').trim().toUpperCase();
      const maxTotalRaw = String(fd.get('max_total_redemptions') ?? '').trim();
      const maxTotal = maxTotalRaw ? Math.max(1, parseInt(maxTotalRaw, 10) || 0) : null;

      const catsRaw = String(fd.get('applies_to_categories') ?? '').trim();
      const cats = catsRaw ? catsRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];

      const faAppId = String(fd.get('fa_application_id') ?? '').trim() || null;
      const condRaw = String(fd.get('conditions_json') ?? '').trim();
      let conditions: Record<string, unknown> = {};
      if (condRaw) {
        try { conditions = JSON.parse(condRaw); }
        catch { return back(request, schoolId, { err: 'conditions_json is not valid JSON' }); }
        if (typeof conditions !== 'object' || Array.isArray(conditions) || conditions === null) {
          return back(request, schoolId, { err: 'conditions_json must be a JSON object' });
        }
      }

      // Kind-specific guards
      if (kind === 'code' && !code) {
        return back(request, schoolId, { err: 'Redemption code required for kind=code' });
      }
      if (kind === 'financial_aid' && !faAppId) {
        return back(request, schoolId, { err: 'FA application ID required for kind=financial_aid' });
      }

      await query(
        `INSERT INTO discount_policies
           (school_id, kind, display_name, percentage_basis_points, amount_cents,
            max_discount_cents, applies_to_categories, conditions,
            redemption_code, max_total_redemptions, fa_application_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)`,
        [
          schoolId, kind, displayName, percentageBp, amountCents,
          maxCents, cats, JSON.stringify(conditions),
          maybe(code), maxTotal, faAppId,
        ],
      );
      return back(request, schoolId, { msg: `Discount "${displayName}" created.` });
    }

    if (op === 'update') {
      const id = String(fd.get('id') ?? '').trim();
      if (!id) return back(request, schoolId, { err: 'Missing id' });
      const displayName = String(fd.get('display_name') ?? '').trim();
      const isActive = fd.get('is_active') === '1';
      await query(
        `UPDATE discount_policies
            SET display_name = $1,
                is_active = $2,
                updated_at = now()
          WHERE id = $3 AND school_id = $4`,
        [displayName, isActive, id, schoolId],
      );
      return back(request, schoolId, { msg: 'Discount updated.' });
    }

    if (op === 'delete') {
      const id = String(fd.get('id') ?? '').trim();
      if (!id) return back(request, schoolId, { err: 'Missing id' });
      // Soft-delete: just deactivate. Hard delete would break the FK on
      // discount_applications (ON DELETE RESTRICT).
      await query(
        `UPDATE discount_policies SET is_active = false, updated_at = now()
          WHERE id = $1 AND school_id = $2`,
        [id, schoolId],
      );
      return back(request, schoolId, { msg: 'Discount deactivated.' });
    }

    return back(request, schoolId, { err: `Unknown op: ${op}` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return back(request, schoolId, { err: msg });
  }
}
