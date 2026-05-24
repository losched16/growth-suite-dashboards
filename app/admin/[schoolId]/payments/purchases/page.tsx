// /admin/[schoolId]/payments/purchases — operator view of every
// product purchase. Filterable by status, product, date range.
// Per-row drilldown links to /purchases/[purchaseId] with refund.

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { ChevronRight, RefreshCw, Globe, User } from 'lucide-react';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string }>;
type SearchParams = Promise<{
  status?: string; product?: string; q?: string;
  from?: string; to?: string;
  page?: string;
}>;

interface PurchaseRow {
  id: string;
  product_id: string;
  product_name: string;
  product_type: string;
  family_id: string | null;
  family_display_name: string | null;
  purchaser_email: string | null;
  purchaser_name: string | null;
  ghl_contact_id: string | null;
  quantity: number;
  total_amount_cents: number;
  status: string;
  source: string;
  refunded_amount_cents: number;
  created_at: string;
}

interface ProductOption {
  id: string;
  name: string;
}

interface CountRow { count: string }

const PAGE_SIZE = 50;

function fmtCents(c: number): string {
  return `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDateTime(s: string): string {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function statusPill(status: string): string {
  switch (status) {
    case 'succeeded':   return 'bg-emerald-100 text-emerald-800';
    case 'pending':     return 'bg-amber-100 text-amber-800';
    case 'failed':      return 'bg-rose-100 text-rose-800';
    case 'canceled':    return 'bg-slate-100 text-slate-700';
    case 'refunded':    return 'bg-blue-100 text-blue-800';
    default:            return 'bg-slate-100 text-slate-700';
  }
}

export default async function PurchasesPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const ck = await cookies();
  if (!verifySessionToken(ck.get(SESSION_COOKIE)?.value)) redirect('/login');
  const { schoolId } = await params;
  const sp = await searchParams;

  const { rows: schoolRows } = await query<{ id: string; name: string }>(
    `SELECT id, name FROM schools WHERE id = $1`, [schoolId],
  );
  if (schoolRows.length === 0) notFound();
  const school = schoolRows[0];

  // Build dynamic WHERE
  const where: string[] = ['pp.school_id = $1'];
  const vals: unknown[] = [schoolId];
  let i = 2;
  if (sp.status) { where.push(`pp.status = $${i++}`); vals.push(sp.status); }
  if (sp.product) { where.push(`pp.product_id = $${i++}`); vals.push(sp.product); }
  if (sp.from) { where.push(`pp.created_at >= $${i++}::date`); vals.push(sp.from); }
  if (sp.to) { where.push(`pp.created_at <= ($${i++}::date + interval '1 day')`); vals.push(sp.to); }
  if (sp.q) {
    where.push(`(LOWER(pp.purchaser_email) LIKE $${i} OR LOWER(pp.purchaser_name) LIKE $${i})`);
    vals.push(`%${sp.q.toLowerCase()}%`);
    i++;
  }

  const page = Math.max(1, Number(sp.page) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const { rows: countRows } = await query<CountRow>(
    `SELECT COUNT(*)::text AS count FROM product_purchases pp WHERE ${where.join(' AND ')}`,
    vals,
  );
  const totalCount = Number(countRows[0]?.count ?? 0);
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  const { rows: purchases } = await query<PurchaseRow>(
    `SELECT pp.id, pp.product_id, sp.name AS product_name, sp.product_type,
            pp.family_id, f.display_name AS family_display_name,
            pp.purchaser_email, pp.purchaser_name, pp.ghl_contact_id,
            pp.quantity, pp.total_amount_cents, pp.status, pp.source,
            pp.refunded_amount_cents, pp.created_at::text
       FROM product_purchases pp
       JOIN school_products sp ON sp.id = pp.product_id
       LEFT JOIN families f ON f.id = pp.family_id
      WHERE ${where.join(' AND ')}
      ORDER BY pp.created_at DESC
      LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
    vals,
  );

  // Summary stats (within filter)
  const { rows: stats } = await query<{
    succeeded_count: string; succeeded_revenue: string;
    pending_count: string; refunded_count: string; refunded_amount: string;
  }>(
    `SELECT
        COUNT(*) FILTER (WHERE pp.status = 'succeeded')::text AS succeeded_count,
        COALESCE(SUM(CASE WHEN pp.status = 'succeeded' THEN pp.total_amount_cents ELSE 0 END), 0)::text AS succeeded_revenue,
        COUNT(*) FILTER (WHERE pp.status = 'pending')::text AS pending_count,
        COUNT(*) FILTER (WHERE pp.status = 'refunded')::text AS refunded_count,
        COALESCE(SUM(pp.refunded_amount_cents), 0)::text AS refunded_amount
      FROM product_purchases pp WHERE ${where.join(' AND ')}`,
    vals,
  );
  const s = stats[0];

  // Product filter options
  const { rows: productOpts } = await query<ProductOption>(
    `SELECT id, name FROM school_products WHERE school_id = $1 ORDER BY name`,
    [schoolId],
  );

  // Build link helper that preserves filter params
  function linkWith(updates: Record<string, string | undefined>): string {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) {
      if (v) params.set(k, v);
    }
    for (const [k, v] of Object.entries(updates)) {
      if (v) params.set(k, v);
      else params.delete(k);
    }
    const qs = params.toString();
    return qs ? `?${qs}` : '';
  }

  return (
    <div className="space-y-5 max-w-7xl">
      <div>
        <Link href={`/admin/${schoolId}/payments`} className="text-xs text-gray-500 hover:text-gray-700">
          ← Back to Payments
        </Link>
      </div>

      <header>
        <h1 className="text-2xl font-semibold text-gray-900">Product purchases</h1>
        <p className="mt-1 text-sm text-gray-600">
          Every charge from {school.name}&rsquo;s product catalog — events, donations, subscriptions, etc.
        </p>
      </header>

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Succeeded" value={Number(s.succeeded_count).toLocaleString()} color="text-emerald-700" />
        <StatCard label="Revenue" value={fmtCents(Number(s.succeeded_revenue))} color="text-emerald-700" />
        <StatCard label="Pending" value={Number(s.pending_count).toLocaleString()} color="text-amber-700" />
        <StatCard label="Refunded" value={`${s.refunded_count} (${fmtCents(Number(s.refunded_amount))})`} color="text-blue-700" />
      </div>

      {/* Filters */}
      <form className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-white p-3">
        <input
          type="search"
          name="q"
          defaultValue={sp.q ?? ''}
          placeholder="Search name or email…"
          className="min-w-0 flex-1 rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-emerald-600 focus:outline-none"
        />
        <select name="product" defaultValue={sp.product ?? ''} className="rounded border border-gray-300 px-2 py-1.5 text-sm">
          <option value="">All products</option>
          {productOpts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select name="status" defaultValue={sp.status ?? ''} className="rounded border border-gray-300 px-2 py-1.5 text-sm">
          <option value="">All statuses</option>
          {['succeeded', 'pending', 'failed', 'canceled', 'refunded'].map((x) => (
            <option key={x} value={x}>{x}</option>
          ))}
        </select>
        <input type="date" name="from" defaultValue={sp.from ?? ''} className="rounded border border-gray-300 px-2 py-1.5 text-sm" title="From date" />
        <input type="date" name="to"   defaultValue={sp.to ?? ''}   className="rounded border border-gray-300 px-2 py-1.5 text-sm" title="To date" />
        <button type="submit" className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800">
          Apply
        </button>
        {(sp.q || sp.product || sp.status || sp.from || sp.to) ? (
          <Link href={`?`} className="text-xs text-gray-500 hover:underline">clear</Link>
        ) : null}
      </form>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-100 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-3 py-2 font-medium">When</th>
              <th className="px-3 py-2 font-medium">Product</th>
              <th className="px-3 py-2 font-medium">Buyer</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium text-right">Amount</th>
              <th className="px-3 py-2 font-medium">Source</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {purchases.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-sm text-gray-500">
                  No purchases match the current filters.
                </td>
              </tr>
            ) : null}
            {purchases.map((p) => (
              <tr key={p.id} className="hover:bg-gray-50">
                <td className="px-3 py-2 align-top text-xs text-gray-700 whitespace-nowrap">
                  {fmtDateTime(p.created_at)}
                </td>
                <td className="px-3 py-2 align-top">
                  <Link href={`/admin/${schoolId}/payments/products/${p.product_id}`} className="text-emerald-700 hover:underline font-medium">
                    {p.product_name}
                  </Link>
                  <div className="text-[10px] text-gray-500">{p.product_type.replace('_', '-')}</div>
                </td>
                <td className="px-3 py-2 align-top">
                  <div className="font-medium text-gray-900">{p.purchaser_name ?? '(no name)'}</div>
                  <div className="text-[11px] text-gray-600">{p.purchaser_email ?? '(no email)'}</div>
                  {p.family_id && p.family_display_name ? (
                    <div className="text-[10px] text-blue-700 mt-0.5">
                      <User className="inline h-2.5 w-2.5 mr-0.5" />
                      {p.family_display_name}
                    </div>
                  ) : null}
                </td>
                <td className="px-3 py-2 align-top">
                  <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${statusPill(p.status)}`}>
                    {p.status}
                  </span>
                  {p.refunded_amount_cents > 0 ? (
                    <div className="text-[10px] text-blue-700 mt-0.5">
                      {fmtCents(p.refunded_amount_cents)} refunded
                    </div>
                  ) : null}
                </td>
                <td className="px-3 py-2 align-top text-right">
                  <div className="font-medium text-gray-900 tabular-nums">{fmtCents(p.total_amount_cents)}</div>
                  {p.quantity > 1 ? <div className="text-[10px] text-gray-500">× {p.quantity}</div> : null}
                </td>
                <td className="px-3 py-2 align-top">
                  <SourcePill source={p.source} />
                </td>
                <td className="px-3 py-2 align-top text-right">
                  <Link
                    href={`/admin/${schoolId}/payments/purchases/${p.id}`}
                    className="inline-flex items-center text-xs text-emerald-700 hover:underline"
                  >
                    Details <ChevronRight className="h-3 w-3" />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 ? (
        <div className="flex items-center justify-between text-xs text-gray-600">
          <div>
            Page {page} of {totalPages} · {totalCount.toLocaleString()} total
          </div>
          <div className="flex gap-2">
            {page > 1 ? (
              <Link href={linkWith({ page: String(page - 1) })} className="rounded border border-gray-300 px-2 py-1 hover:bg-gray-50">← Prev</Link>
            ) : null}
            {page < totalPages ? (
              <Link href={linkWith({ page: String(page + 1) })} className="rounded border border-gray-300 px-2 py-1 hover:bg-gray-50">Next →</Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
      <div className={`text-2xl font-semibold ${color}`}>{value}</div>
      <div className="mt-1 text-xs uppercase tracking-wide text-gray-500">{label}</div>
    </div>
  );
}

function SourcePill({ source }: { source: string }) {
  const map: Record<string, { label: string; icon: typeof Globe; cls: string }> = {
    portal:        { label: 'Portal',    icon: User,  cls: 'bg-blue-100 text-blue-800' },
    hosted_link:   { label: 'Link',      icon: Globe, cls: 'bg-purple-100 text-purple-800' },
    ghl_form:      { label: 'GHL form',  icon: Globe, cls: 'bg-violet-100 text-violet-800' },
    admin_manual:  { label: 'Manual',    icon: User,  cls: 'bg-slate-100 text-slate-700' },
  };
  const entry = map[source] ?? { label: source, icon: Globe, cls: 'bg-slate-100 text-slate-700' };
  const Icon = entry.icon;
  return (
    <span className={`inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${entry.cls}`}>
      <Icon className="h-3 w-3" /> {entry.label}
    </span>
  );
}
