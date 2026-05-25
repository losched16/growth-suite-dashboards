// /school/[locationId]/payments/products/new — embedded create.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { ProductForm } from '@/app/admin/[schoolId]/payments/products/ProductForm';

export const dynamic = 'force-dynamic';

type Params = Promise<{ locationId: string }>;

export default async function SchoolNewProductPage({ params }: { params: Params }) {
  const { locationId } = await params;
  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="bg-white border-b border-slate-200">
        <div className="px-6 py-5">
          <Link href={`/school/${locationId}/payments/products`} className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 mb-2">
            <ArrowLeft className="h-3 w-3" /> Back to products
          </Link>
          <h1 className="text-2xl font-semibold text-slate-900">Create product</h1>
          <p className="text-sm text-slate-600 mt-1">
            Anything you charge for that isn&rsquo;t tuition. Set it up once, share the link anywhere.
          </p>
        </div>
      </div>
      <div className="px-6 py-5">
        <ProductForm
          schoolId={school.id}
          returnPathBase={`/school/${locationId}/payments/products`}
        />
      </div>
    </div>
  );
}
