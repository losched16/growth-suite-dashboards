// /admin/[schoolId]/payments/products/[productId] — edit a product.

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { query } from '@/lib/db';
import { ProductForm } from '../ProductForm';

export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string; productId: string }>;

interface ProductRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  product_type: 'one_time' | 'recurring' | 'donation';
  price_cents: number | null;
  suggested_amounts_cents: number[] | null;
  donation_min_cents: number | null;
  recurring_interval: 'month' | 'year' | null;
  recurring_installment_count: number | null;
  recurring_first_charge_date: string | null;
  per_student: boolean;
  max_quantity: number | null;
  available_to: 'parents' | 'public' | 'both';
  available_from: string | null;
  available_until: string | null;
  image_url: string | null;
  ghl_writeback_field: string | null;
  is_active: boolean;
  internal_note: string | null;
  purchase_count: number;
  total_revenue_cents: number;
}

export default async function EditProductPage({ params }: { params: Params }) {
  const ck = await cookies();
  if (!verifySessionToken(ck.get(SESSION_COOKIE)?.value)) {
    redirect('/login');
  }
  const { schoolId, productId } = await params;

  const rows = (await query<ProductRow>(
    `SELECT p.*,
            COALESCE((SELECT COUNT(*) FROM product_purchases pp
                      WHERE pp.product_id = p.id AND pp.status = 'succeeded'), 0)::int AS purchase_count,
            COALESCE((SELECT SUM(total_amount_cents) FROM product_purchases pp
                      WHERE pp.product_id = p.id AND pp.status = 'succeeded'), 0)::int AS total_revenue_cents
       FROM school_products p
      WHERE p.id = $1 AND p.school_id = $2`,
    [productId, schoolId],
  )).rows;
  if (rows.length === 0) notFound();
  const product = rows[0];

  return (
    <div className="space-y-5">
      <div>
        <Link href={`/admin/${schoolId}/payments/products`} className="text-xs text-gray-500 hover:text-gray-700">
          ← Back to products
        </Link>
      </div>
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">{product.name}</h1>
          <p className="mt-1 text-sm text-gray-600 font-mono text-xs">slug: {product.slug}</p>
        </div>
        <div className="text-right text-xs text-gray-600">
          <div>{product.purchase_count} purchase{product.purchase_count === 1 ? '' : 's'}</div>
          <div>${(product.total_revenue_cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} revenue</div>
        </div>
      </header>
      <ProductForm schoolId={schoolId} product={product} />
    </div>
  );
}
