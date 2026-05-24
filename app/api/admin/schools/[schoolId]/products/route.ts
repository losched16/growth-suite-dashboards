// POST /api/admin/schools/[schoolId]/products
//   Create a new product.
//
// Operator-authed (SESSION_COOKIE). Body is JSON shaped like the form
// payload — see ProductForm.tsx for the contract.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string }>;

interface CreateBody {
  slug: string;
  name: string;
  description?: string | null;
  category?: string | null;
  product_type: 'one_time' | 'recurring' | 'donation';
  price_cents?: number | null;
  suggested_amounts_cents?: number[];
  donation_min_cents?: number | null;
  recurring_interval?: 'month' | 'year' | null;
  recurring_installment_count?: number | null;
  recurring_first_charge_date?: string | null;
  per_student?: boolean;
  max_quantity?: number | null;
  available_to?: 'parents' | 'public' | 'both';
  available_from?: string | null;
  available_until?: string | null;
  image_url?: string | null;
  ghl_writeback_field?: string | null;
  is_active?: boolean;
  internal_note?: string | null;
}

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const ck = await cookies();
  if (!verifySessionToken(ck.get(SESSION_COOKIE)?.value)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { schoolId } = await params;

  let body: CreateBody;
  try {
    body = (await request.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  // Validation. Errors here are user-facing so we return readable text.
  const errors: string[] = [];
  const slug = (body.slug ?? '').trim().toLowerCase();
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) errors.push('slug must be lowercase letters/numbers/hyphens');
  if (!body.name || !body.name.trim()) errors.push('name is required');
  if (!['one_time', 'recurring', 'donation'].includes(body.product_type)) errors.push('product_type invalid');
  if (body.product_type === 'one_time' || body.product_type === 'recurring') {
    if (!body.price_cents || body.price_cents < 50) errors.push('price must be at least $0.50');
  }
  if (body.product_type === 'recurring') {
    if (!body.recurring_interval || !['month', 'year'].includes(body.recurring_interval)) {
      errors.push('recurring_interval must be month or year');
    }
  }
  if (errors.length > 0) {
    return NextResponse.json({ error: 'validation_failed', detail: errors.join('; ') }, { status: 400 });
  }

  // Verify school exists (cheap sanity check)
  const sc = (await query<{ id: string }>(`SELECT id FROM schools WHERE id = $1`, [schoolId])).rows;
  if (sc.length === 0) {
    return NextResponse.json({ error: 'school_not_found' }, { status: 404 });
  }

  // Insert. The UNIQUE (school_id, slug) constraint protects us from duplicates.
  try {
    const ins = await query<{ id: string }>(
      `INSERT INTO school_products (
         school_id, slug, name, description, category, product_type,
         price_cents, suggested_amounts_cents, donation_min_cents,
         recurring_interval, recurring_installment_count, recurring_first_charge_date,
         per_student, max_quantity, available_to, available_from, available_until,
         image_url, ghl_writeback_field, is_active, internal_note
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8::int[], $9,
         $10, $11, $12::date,
         $13, $14, $15, $16::timestamptz, $17::timestamptz,
         $18, $19, $20, $21
       ) RETURNING id`,
      [
        schoolId, slug, body.name.trim(), body.description ?? null, body.category ?? null,
        body.product_type,
        body.price_cents ?? null,
        body.suggested_amounts_cents && body.suggested_amounts_cents.length > 0 ? body.suggested_amounts_cents : null,
        body.donation_min_cents ?? null,
        body.recurring_interval ?? null, body.recurring_installment_count ?? null,
        body.recurring_first_charge_date ?? null,
        body.per_student ?? false, body.max_quantity ?? null,
        body.available_to ?? 'both',
        body.available_from ?? null, body.available_until ?? null,
        body.image_url ?? null, body.ghl_writeback_field ?? null,
        body.is_active ?? true, body.internal_note ?? null,
      ],
    );
    return NextResponse.json({ ok: true, id: ins.rows[0].id }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('school_products_school_id_slug_key')) {
      return NextResponse.json(
        { error: 'duplicate_slug', detail: `A product with slug "${slug}" already exists for this school.` },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: 'insert_failed', detail: msg }, { status: 500 });
  }
}
