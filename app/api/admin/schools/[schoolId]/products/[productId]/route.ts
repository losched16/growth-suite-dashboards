// PATCH /api/admin/schools/[schoolId]/products/[productId]
//   Update an existing product. Same body shape as POST (partial OK).
//
// DELETE /api/admin/schools/[schoolId]/products/[productId]
//   Soft-delete by setting is_active=false. Preserves purchase history
//   and any in-flight Stripe subscriptions. To true-delete, use the
//   `?hard=1` query param (rejected if any product_purchases exist).

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { authorizeOperatorOrSchool } from '@/lib/auth/dual';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string; productId: string }>;

export async function PATCH(request: NextRequest, { params }: { params: Params }) {
  const { schoolId, productId } = await params;
  const auth = await authorizeOperatorOrSchool(schoolId);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  // Verify product belongs to school
  const exists = (await query<{ id: string }>(
    `SELECT id FROM school_products WHERE id = $1 AND school_id = $2`,
    [productId, schoolId],
  )).rows;
  if (exists.length === 0) {
    return NextResponse.json({ error: 'product_not_found' }, { status: 404 });
  }

  // Build dynamic UPDATE SET clause from whitelisted fields
  const allowed = [
    'slug', 'name', 'description', 'category',
    'product_type', 'price_cents', 'suggested_amounts_cents', 'donation_min_cents',
    'recurring_interval', 'recurring_installment_count', 'recurring_first_charge_date',
    'per_student', 'max_quantity', 'available_to', 'available_from', 'available_until',
    'image_url', 'ghl_writeback_field', 'is_active', 'internal_note',
  ];
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, k)) {
      // For array fields and date fields we need explicit cast hints
      if (k === 'suggested_amounts_cents') {
        sets.push(`${k} = $${i++}::int[]`);
        const arr = body[k];
        vals.push(Array.isArray(arr) && arr.length > 0 ? arr : null);
      } else if (k === 'recurring_first_charge_date') {
        sets.push(`${k} = $${i++}::date`);
        vals.push(body[k] || null);
      } else if (k === 'available_from' || k === 'available_until') {
        sets.push(`${k} = $${i++}::timestamptz`);
        vals.push(body[k] || null);
      } else {
        sets.push(`${k} = $${i++}`);
        vals.push(body[k] === '' ? null : body[k]);
      }
    }
  }
  if (sets.length === 0) return NextResponse.json({ ok: true, id: productId, noop: true });
  sets.push(`updated_at = now()`);

  vals.push(productId);
  try {
    await query(
      `UPDATE school_products SET ${sets.join(', ')} WHERE id = $${i}`,
      vals,
    );
    return NextResponse.json({ ok: true, id: productId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('school_products_school_id_slug_key')) {
      return NextResponse.json(
        { error: 'duplicate_slug', detail: 'A product with that slug already exists.' },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: 'update_failed', detail: msg }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Params }) {
  const { schoolId, productId } = await params;
  const auth = await authorizeOperatorOrSchool(schoolId);
  if (!auth.ok) return auth.response;
  const hard = request.nextUrl.searchParams.get('hard') === '1';

  // Verify ownership
  const exists = (await query<{ id: string }>(
    `SELECT id FROM school_products WHERE id = $1 AND school_id = $2`,
    [productId, schoolId],
  )).rows;
  if (exists.length === 0) {
    return NextResponse.json({ error: 'product_not_found' }, { status: 404 });
  }

  if (hard) {
    const purchases = (await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM product_purchases WHERE product_id = $1`,
      [productId],
    )).rows;
    if (Number(purchases[0]?.count ?? 0) > 0) {
      return NextResponse.json(
        { error: 'has_purchases', detail: 'Cannot hard-delete a product with purchase history. Deactivate instead.' },
        { status: 409 },
      );
    }
    await query(`DELETE FROM school_products WHERE id = $1`, [productId]);
    return NextResponse.json({ ok: true, deleted: true });
  }

  // Soft delete = deactivate
  await query(
    `UPDATE school_products SET is_active = false, updated_at = now() WHERE id = $1`,
    [productId],
  );
  return NextResponse.json({ ok: true, deactivated: true });
}
