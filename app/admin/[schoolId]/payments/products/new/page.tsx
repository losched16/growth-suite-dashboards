// /admin/[schoolId]/payments/products/new — create a new product.

import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { ProductForm } from '../ProductForm';

export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string }>;

export default async function NewProductPage({ params }: { params: Params }) {
  const ck = await cookies();
  if (!verifySessionToken(ck.get(SESSION_COOKIE)?.value)) {
    redirect('/login');
  }
  const { schoolId } = await params;

  return (
    <div className="space-y-5">
      <div>
        <Link href={`/admin/${schoolId}/payments/products`} className="text-xs text-gray-500 hover:text-gray-700">
          ← Back to products
        </Link>
      </div>
      <header>
        <h1 className="text-2xl font-semibold text-gray-900">Create product</h1>
        <p className="mt-1 text-sm text-gray-600">
          Anything your school charges for that isn&rsquo;t tuition. Set it up once,
          share the link anywhere.
        </p>
      </header>
      <ProductForm schoolId={schoolId} />
    </div>
  );
}
