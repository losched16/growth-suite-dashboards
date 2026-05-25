// Catalog tab — quick view of products + a launchpad to the full
// product editor at /school/[locationId]/payments/products. Keeps
// every link inside the school iframe namespace; no /admin escapes.
//
// "Products" here means anything a school sells that isn't tuition:
// one-time charges (registration, supplies, event tickets), donations
// (pay-what-you-want with suggested tiers), and recurring subscriptions
// (camp series, lunch programs).

import Link from 'next/link';
import { Plus, Tag, ExternalLink, ArrowRight, Calendar, Globe, Lock } from 'lucide-react';
import { query } from '@/lib/db';
import { HelpCallout } from '@/components/HelpCallout';

interface ProductRow {
  id: string;
  slug: string;
  name: string;
  product_type: 'one_time' | 'recurring' | 'donation';
  price_cents: number | null;
  recurring_interval: 'month' | 'year' | null;
  available_to: 'parents' | 'public' | 'both';
  per_student: boolean;
  is_active: boolean;
  purchase_count: number;
  total_revenue_cents: number;
}

function fmtCents(cents: number | null | undefined): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export async function PaymentsHubCatalog({
  schoolId, locationId,
}: { schoolId: string; locationId: string }) {
  const { rows: products } = await query<ProductRow>(
    `SELECT p.id, p.slug, p.name, p.product_type, p.price_cents,
            p.recurring_interval, p.available_to, p.per_student, p.is_active,
            COALESCE((SELECT COUNT(*) FROM product_purchases pp
                      WHERE pp.product_id = p.id AND pp.status = 'succeeded'), 0)::int AS purchase_count,
            COALESCE((SELECT SUM(total_amount_cents) FROM product_purchases pp
                      WHERE pp.product_id = p.id AND pp.status = 'succeeded'), 0)::int AS total_revenue_cents
       FROM school_products p
      WHERE p.school_id = $1
      ORDER BY p.is_active DESC, p.position ASC, p.created_at DESC
      LIMIT 12`,
    [schoolId],
  );

  const activeCount = products.filter((p) => p.is_active).length;
  const totalRevenue = products.reduce((s, p) => s + (p.total_revenue_cents || 0), 0);
  const totalPurchases = products.reduce((s, p) => s + (p.purchase_count || 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Catalog</h2>
          <p className="text-sm text-slate-500">
            Anything you charge for that isn&rsquo;t tuition — registration fees, event tickets,
            donations, fundraisers, supplies, summer programs.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/school/${locationId}/payments/products`}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Manage all products <ArrowRight className="h-4 w-4" />
          </Link>
          <Link
            href={`/school/${locationId}/payments/products/new`}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" /> New product
          </Link>
        </div>
      </div>

      <HelpCallout
        title="How the catalog works"
        defaultOpen={products.length === 0}
        steps={[
          <>Each product gets a unique public link like <code className="bg-white border border-slate-200 px-1 rounded">/pay/your-school/&lt;slug&gt;</code>. Anyone with the link can pay; we charge through your Stripe Connect account and log the purchase here.</>,
          <><strong>One-time</strong> products charge a fixed amount once (event tickets, registration). <strong>Recurring</strong> products bill on a monthly or yearly schedule (lunch programs, after-school care). <strong>Donations</strong> let parents pay any amount, with optional suggested tiers and a minimum.</>,
          <>You can mark a product <strong>per-student</strong> (parents pick which kid the charge applies to) and gate <strong>availability</strong> to logged-in parents only, the public, or both.</>,
          <>Drop the public link into a GHL form&rsquo;s &ldquo;Thank you&rdquo; redirect, an email blast, a social post, or your school&rsquo;s website to start collecting payments immediately.</>,
        ]}
      />

      {/* KPI strip */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard label="Active products" value={activeCount.toString()} hint={`${products.length} total in catalog`} />
        <StatCard label="Total purchases" value={totalPurchases.toString()} hint="across all products" />
        <StatCard label="Revenue collected" value={fmtCents(totalRevenue)} hint="lifetime, all products" />
      </div>

      {/* Preview grid or empty state */}
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
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {products.map((p) => (
              <Link
                key={p.id}
                href={`/school/${locationId}/payments/products/${p.id}`}
                className={`rounded-lg border border-slate-200 bg-white p-4 hover:border-blue-300 hover:shadow-sm transition ${!p.is_active ? 'opacity-60' : ''}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-medium text-slate-900 truncate">{p.name}</div>
                    <div className="text-[11px] text-slate-500 font-mono truncate">{p.slug}</div>
                  </div>
                  <ProductTypePill type={p.product_type} interval={p.recurring_interval} />
                </div>
                <div className="mt-3 flex items-baseline justify-between gap-2">
                  <div className="text-sm font-semibold text-slate-900">
                    {p.product_type === 'donation' ? 'Any amount' : fmtCents(p.price_cents)}
                    {p.product_type === 'recurring' && p.recurring_interval ? (
                      <span className="text-[11px] text-slate-500 ml-1 font-normal">/{p.recurring_interval}</span>
                    ) : null}
                  </div>
                  <AvailabilityPill av={p.available_to} perStudent={p.per_student} />
                </div>
                <div className="mt-3 flex items-center justify-between text-[11px] text-slate-500 border-t border-slate-100 pt-2">
                  <span>{p.purchase_count} purchase{p.purchase_count === 1 ? '' : 's'}</span>
                  <span>{fmtCents(p.total_revenue_cents)}</span>
                </div>
                {!p.is_active ? (
                  <div className="mt-2 inline-block rounded bg-slate-200 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-700">inactive</div>
                ) : null}
              </Link>
            ))}
          </div>

          <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900 flex items-center justify-between gap-3 flex-wrap">
            <div className="inline-flex items-center gap-2">
              <ExternalLink className="h-4 w-4" />
              Want to see purchases, refund a payment, or edit any product in detail?
            </div>
            <Link
              href={`/school/${locationId}/payments/products`}
              className="inline-flex items-center gap-1 rounded-md bg-white border border-blue-300 px-2.5 py-1 font-semibold text-blue-700 hover:bg-blue-100"
            >
              Open full catalog <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
        </>
      )}
      {void locationId}
    </div>
  );
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-slate-900 tabular-nums">{value}</div>
      {hint ? <div className="text-[11px] text-slate-500 mt-0.5">{hint}</div> : null}
    </div>
  );
}

function ProductTypePill({ type, interval }: { type: 'one_time' | 'recurring' | 'donation'; interval: 'month' | 'year' | null }) {
  if (type === 'one_time') {
    return <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-700 whitespace-nowrap">One-time</span>;
  }
  if (type === 'recurring') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-violet-700 whitespace-nowrap">
        <Calendar className="h-3 w-3" /> {interval === 'year' ? 'Yearly' : 'Monthly'}
      </span>
    );
  }
  return <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700 whitespace-nowrap">Donation</span>;
}

function AvailabilityPill({ av, perStudent }: { av: 'parents' | 'public' | 'both'; perStudent: boolean }) {
  const cfg = av === 'parents'
    ? { Icon: Lock, text: 'Parents', cls: 'bg-amber-100 text-amber-800' }
    : { Icon: Globe, text: av === 'both' ? 'Both' : 'Public', cls: 'bg-blue-100 text-blue-800' };
  return (
    <div className="flex items-center gap-1">
      <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide whitespace-nowrap ${cfg.cls}`}>
        <cfg.Icon className="h-3 w-3" /> {cfg.text}
      </span>
      {perStudent ? (
        <span className="inline-flex items-center gap-0.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-700 whitespace-nowrap" title="Per-student charge">
          /student
        </span>
      ) : null}
    </div>
  );
}
