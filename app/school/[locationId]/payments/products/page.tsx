// /school/[locationId]/payments/products — embedded school-staff view
// of the product catalog. Same content as /admin/[schoolId]/payments/
// products but rendered inside the school iframe layout (no admin
// chrome, no cross-school nav, no iframe-escape risk).

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Plus, Tag, ExternalLink, Calendar, Users, Globe, Lock } from 'lucide-react';
import { query } from '@/lib/db';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';

export const dynamic = 'force-dynamic';

type Params = Promise<{ locationId: string }>;
type SearchParams = Promise<{ msg?: string; err?: string }>;

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
  per_student: boolean;
  available_to: 'parents' | 'public' | 'both';
  is_active: boolean;
  position: number;
  purchase_count: number;
  total_revenue_cents: number;
  last_purchase_at: string | null;
}

function fmtCents(cents: number | null | undefined): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(s: string | null): string {
  if (!s) return '—';
  return new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default async function SchoolProductsPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { locationId } = await params;
  const sp = await searchParams;

  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();
  const schoolId = school.id;

  const products = (await query<ProductRow>(
    `SELECT p.id, p.slug, p.name, p.description, p.category, p.product_type,
            p.price_cents, p.suggested_amounts_cents, p.donation_min_cents,
            p.recurring_interval, p.recurring_installment_count,
            p.per_student, p.available_to, p.is_active, p.position,
            COALESCE((SELECT COUNT(*) FROM product_purchases pp
                      WHERE pp.product_id = p.id AND pp.status = 'succeeded'), 0)::int AS purchase_count,
            COALESCE((SELECT SUM(total_amount_cents) FROM product_purchases pp
                      WHERE pp.product_id = p.id AND pp.status = 'succeeded'), 0)::int AS total_revenue_cents,
            (SELECT MAX(created_at) FROM product_purchases pp
              WHERE pp.product_id = p.id AND pp.status = 'succeeded')::text AS last_purchase_at
       FROM school_products p
      WHERE p.school_id = $1
      ORDER BY p.is_active DESC, p.position ASC, p.created_at DESC`,
    [schoolId],
  )).rows;

  const parentPortalBase = process.env.PARENT_PORTAL_BASE
    || 'https://growth-suite-parent-portal.vercel.app';
  const schoolSlugForUrl = school.ghl_location_id || school.id;

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="bg-white border-b border-slate-200">
        <div className="px-6 py-5">
          <Link href={`/school/${locationId}/payments`} className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 mb-2">
            <ArrowLeft className="h-3 w-3" /> Back to Payments
          </Link>
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <div>
              <h1 className="text-2xl font-semibold text-slate-900">Product catalog</h1>
              <p className="text-sm text-slate-600">
                Anything you charge for that isn&rsquo;t tuition — event tickets, donations,
                fundraisers, supplies. Each gets a sharable public payment link.
              </p>
            </div>
            <Link
              href={`/school/${locationId}/payments/products/new`}
              className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700"
            >
              <Plus className="h-4 w-4" /> Create product
            </Link>
          </div>
        </div>
      </div>

      <div className="px-6 py-5 space-y-4">
        {sp.msg ? (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{sp.msg}</div>
        ) : null}
        {sp.err ? (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{sp.err}</div>
        ) : null}

        {products.length === 0 ? (
          <div className="rounded-lg border-2 border-dashed border-slate-300 bg-white p-12 text-center">
            <Tag className="mx-auto h-8 w-8 text-slate-300" />
            <p className="mt-3 text-sm text-slate-700 font-medium">No products yet</p>
            <p className="mt-1 text-xs text-slate-500 max-w-sm mx-auto">
              Create your first product — anything you want to charge for outside of tuition.
              One-time, recurring, or pay-what-you-want donations all live here.
            </p>
            <Link
              href={`/school/${locationId}/payments/products/new`}
              className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700"
            >
              <Plus className="h-4 w-4" /> Create your first product
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">Product</th>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Price</th>
                  <th className="px-3 py-2 font-medium">Availability</th>
                  <th className="px-3 py-2 font-medium text-right">Purchases</th>
                  <th className="px-3 py-2 font-medium text-right">Revenue</th>
                  <th className="px-3 py-2 font-medium">Public link</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {products.map((p) => {
                  const hostedUrl = `${parentPortalBase}/pay/${schoolSlugForUrl}/${p.slug}`;
                  return (
                    <tr key={p.id} className={`hover:bg-slate-50 ${!p.is_active ? 'opacity-60' : ''}`}>
                      <td className="px-3 py-2 align-top">
                        <div className="font-medium text-slate-900">
                          {p.name}
                          {!p.is_active ? (
                            <span className="ml-2 rounded bg-slate-200 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-700">inactive</span>
                          ) : null}
                        </div>
                        {p.category ? <div className="text-[11px] text-slate-500">{p.category}</div> : null}
                        {p.description ? <div className="mt-0.5 text-xs text-slate-600 line-clamp-1">{p.description}</div> : null}
                      </td>
                      <td className="px-3 py-2 align-top">
                        <ProductTypePill type={p.product_type} interval={p.recurring_interval} />
                      </td>
                      <td className="px-3 py-2 align-top">
                        {p.product_type === 'donation' ? (
                          <div>
                            <div className="text-slate-700">
                              {p.suggested_amounts_cents && p.suggested_amounts_cents.length > 0
                                ? p.suggested_amounts_cents.map(fmtCents).join(' · ')
                                : 'Any amount'}
                            </div>
                            {p.donation_min_cents ? (
                              <div className="text-[11px] text-slate-500">min {fmtCents(p.donation_min_cents)}</div>
                            ) : null}
                          </div>
                        ) : (
                          <div className="text-slate-900 font-medium">
                            {fmtCents(p.price_cents)}
                            {p.product_type === 'recurring' ? (
                              <span className="text-[11px] text-slate-500 ml-1">
                                /{p.recurring_interval}
                                {p.recurring_installment_count ? ` × ${p.recurring_installment_count}` : ''}
                              </span>
                            ) : null}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 align-top">
                        <AvailabilityPill av={p.available_to} perStudent={p.per_student} />
                      </td>
                      <td className="px-3 py-2 align-top text-right text-slate-700">
                        {p.purchase_count}
                        {p.last_purchase_at ? <div className="text-[10px] text-slate-500">last: {fmtDate(p.last_purchase_at)}</div> : null}
                      </td>
                      <td className="px-3 py-2 align-top text-right font-medium text-slate-900">{fmtCents(p.total_revenue_cents)}</td>
                      <td className="px-3 py-2 align-top">
                        <a href={hostedUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-xs text-blue-600 hover:underline" title={hostedUrl}>
                          /pay/.../{p.slug} <ExternalLink className="h-3 w-3" />
                        </a>
                      </td>
                      <td className="px-3 py-2 align-top text-right">
                        <Link href={`/school/${locationId}/payments/products/${p.id}`} className="text-xs text-blue-600 hover:underline">Edit</Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="rounded-md border border-blue-200 bg-blue-50 p-4 text-xs text-blue-900">
          <p className="font-semibold mb-1">How public payment links work</p>
          <p>
            Each product gets a unique URL like{' '}
            <code className="bg-white border border-blue-200 px-1 py-0.5 rounded">
              {parentPortalBase}/pay/{schoolSlugForUrl}/&lt;slug&gt;
            </code>
            . Drop it into a GHL form&rsquo;s &ldquo;Thank you&rdquo; redirect, an email, a social
            post, or anywhere else. Anyone clicking can pay — we charge through your Stripe Connect
            account and log the purchase here.
          </p>
        </div>
      </div>
    </div>
  );
}

function ProductTypePill({ type, interval }: { type: 'one_time' | 'recurring' | 'donation'; interval: 'month' | 'year' | null }) {
  if (type === 'one_time') return <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-700">One-time</span>;
  if (type === 'recurring') return (
    <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-violet-700">
      <Calendar className="h-3 w-3" /> {interval === 'year' ? 'Yearly' : 'Monthly'}
    </span>
  );
  return <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700">Donation</span>;
}

function AvailabilityPill({ av, perStudent }: { av: 'parents' | 'public' | 'both'; perStudent: boolean }) {
  const labels = {
    parents: { icon: Lock, text: 'Parents only', cls: 'bg-amber-100 text-amber-800' },
    public:  { icon: Globe, text: 'Public', cls: 'bg-blue-100 text-blue-800' },
    both:    { icon: Globe, text: 'Both', cls: 'bg-blue-100 text-blue-800' },
  };
  const { icon: Icon, text, cls } = labels[av];
  return (
    <div className="flex flex-col gap-0.5">
      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cls} w-fit`}>
        <Icon className="h-3 w-3" /> {text}
      </span>
      {perStudent ? (
        <span className="inline-flex items-center gap-0.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-700 w-fit">
          <Users className="h-3 w-3" /> per student
        </span>
      ) : null}
    </div>
  );
}
