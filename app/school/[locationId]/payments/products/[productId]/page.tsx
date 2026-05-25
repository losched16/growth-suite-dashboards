// /school/[locationId]/payments/products/[productId] — embedded edit.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { query } from '@/lib/db';
import { ProductForm } from '@/app/admin/[schoolId]/payments/products/ProductForm';

export const dynamic = 'force-dynamic';

type Params = Promise<{ locationId: string; productId: string }>;

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

export default async function SchoolEditProductPage({ params }: { params: Params }) {
  const { locationId, productId } = await params;
  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();

  const rows = (await query<ProductRow>(
    `SELECT p.*,
            COALESCE((SELECT COUNT(*) FROM product_purchases pp
                      WHERE pp.product_id = p.id AND pp.status = 'succeeded'), 0)::int AS purchase_count,
            COALESCE((SELECT SUM(total_amount_cents) FROM product_purchases pp
                      WHERE pp.product_id = p.id AND pp.status = 'succeeded'), 0)::int AS total_revenue_cents
       FROM school_products p
      WHERE p.id = $1 AND p.school_id = $2`,
    [productId, school.id],
  )).rows;
  if (rows.length === 0) notFound();
  const product = rows[0];

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="bg-white border-b border-slate-200">
        <div className="px-6 py-5">
          <Link href={`/school/${locationId}/payments/products`} className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 mb-2">
            <ArrowLeft className="h-3 w-3" /> Back to products
          </Link>
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <div>
              <h1 className="text-2xl font-semibold text-slate-900">{product.name}</h1>
              <p className="mt-1 text-xs text-slate-500 font-mono">slug: {product.slug}</p>
            </div>
            <div className="text-right text-xs text-slate-600">
              <div>{product.purchase_count} purchase{product.purchase_count === 1 ? '' : 's'}</div>
              <div>${(product.total_revenue_cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} revenue</div>
            </div>
          </div>
        </div>
      </div>
      <div className="px-6 py-5">
        <ProductForm
          schoolId={school.id}
          product={product}
          returnPathBase={`/school/${locationId}/payments/products`}
        />
      </div>
    </div>
  );
}
