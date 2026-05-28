// /admin/webhook-log — operator-only Stripe webhook event log.
//
// When something breaks at school #67, this is where you debug. Shows
// every event we've received, what status it landed in (received /
// processed / failed), the error message if failed, which school it
// belongs to, and a payload-expansion toggle for the JSON.
//
// Default filter: latest 200 events. Failed-only filter at the top to
// jump straight to what needs attention.

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ status?: string; school?: string; type?: string }>;

interface LogRow {
  event_id: string;
  event_type: string;
  payload: Record<string, unknown> | null;
  school_id: string | null;
  school_name: string | null;
  stripe_account_id: string | null;
  livemode: boolean | null;
  status: 'received' | 'processed' | 'failed';
  error_message: string | null;
  stripe_created_at: Date | null;
  received_at: Date;
  processed_at: Date | null;
}

export default async function WebhookLogPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const statusFilter = sp.status === 'failed' || sp.status === 'received' || sp.status === 'processed'
    ? sp.status : null;
  const typeFilter = sp.type ?? null;

  const whereParts: string[] = [];
  const args: unknown[] = [];
  if (statusFilter) {
    whereParts.push(`l.status = $${args.length + 1}`);
    args.push(statusFilter);
  }
  if (typeFilter) {
    whereParts.push(`l.event_type = $${args.length + 1}`);
    args.push(typeFilter);
  }
  const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

  const { rows } = await query<LogRow>(
    `SELECT l.event_id, l.event_type, l.payload, l.school_id,
            s.name AS school_name,
            l.stripe_account_id, l.livemode, l.status, l.error_message,
            l.stripe_created_at, l.received_at, l.processed_at
       FROM stripe_webhook_log l
       LEFT JOIN schools s ON s.id = l.school_id
       ${whereSql}
      ORDER BY l.received_at DESC
      LIMIT 200`,
    args,
  );

  // KPIs over the WHOLE log (not just the filter slice).
  const { rows: kpis } = await query<{ total: string; failed: string; in_24h: string; failed_24h: string }>(
    `SELECT COUNT(*)::text AS total,
            COUNT(*) FILTER (WHERE status = 'failed')::text AS failed,
            COUNT(*) FILTER (WHERE received_at > now() - interval '24 hours')::text AS in_24h,
            COUNT(*) FILTER (WHERE status = 'failed' AND received_at > now() - interval '24 hours')::text AS failed_24h
       FROM stripe_webhook_log`,
  );
  const k = kpis[0];

  return (
    <main className="flex flex-1 flex-col items-center bg-slate-50 p-6 min-h-screen">
      <div className="w-full max-w-7xl space-y-4">
        <Link href="/admin" className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700">
          <ArrowLeft className="h-3 w-3" /> Back to school list
        </Link>

        <header className="flex items-baseline justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">Stripe webhook log</h1>
            <p className="mt-1 text-sm text-slate-500">
              Every event we&rsquo;ve received from Stripe. Use the failed-only filter when something&rsquo;s wrong.
            </p>
          </div>
        </header>

        {/* KPIs */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard label="Total events" value={k?.total ?? '0'} />
          <KpiCard label="Last 24h" value={k?.in_24h ?? '0'} />
          <KpiCard label="Failed (all time)" value={k?.failed ?? '0'} accent={Number(k?.failed ?? 0) > 0 ? 'rose' : 'slate'} />
          <KpiCard label="Failed (24h)" value={k?.failed_24h ?? '0'} accent={Number(k?.failed_24h ?? 0) > 0 ? 'rose' : 'slate'} />
        </div>

        {/* Filters */}
        <div className="flex items-center gap-2 flex-wrap">
          <FilterChip label="All" href="/admin/webhook-log" active={!statusFilter} />
          <FilterChip label="Failed only" href="/admin/webhook-log?status=failed" active={statusFilter === 'failed'} />
          <FilterChip label="Processed" href="/admin/webhook-log?status=processed" active={statusFilter === 'processed'} />
          <FilterChip label="Received (pending)" href="/admin/webhook-log?status=received" active={statusFilter === 'received'} />
        </div>

        {/* Table */}
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200 text-left text-[10px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2.5 font-semibold">When</th>
                <th className="px-3 py-2.5 font-semibold">Event</th>
                <th className="px-3 py-2.5 font-semibold">Status</th>
                <th className="px-3 py-2.5 font-semibold">School</th>
                <th className="px-3 py-2.5 font-semibold">Mode</th>
                <th className="px-3 py-2.5 font-semibold">Error / details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.length === 0 ? (
                <tr><td colSpan={6} className="p-10 text-center text-slate-500 italic">No events match the current filter.</td></tr>
              ) : rows.map((r) => (
                <tr key={r.event_id} className={r.status === 'failed' ? 'bg-rose-50/30' : ''}>
                  <td className="px-3 py-2 text-xs text-slate-600 tabular-nums whitespace-nowrap">
                    {fmtTimeAgo(r.received_at)}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <code className="font-mono">{r.event_type}</code>
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.school_name ? (
                      <Link href={`/admin/${r.school_id}/payments`} className="text-blue-600 hover:underline">
                        {r.school_name}
                      </Link>
                    ) : r.stripe_account_id ? (
                      <span className="font-mono text-[10px] text-slate-500" title="No payment_accounts row for this account yet">{r.stripe_account_id.slice(0, 14)}…</span>
                    ) : (
                      <span className="text-slate-400 italic">no account</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {r.livemode === true ? (
                      <span className="inline-block rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800">live</span>
                    ) : r.livemode === false ? (
                      <span className="inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">test</span>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.error_message ? (
                      <code className="text-rose-700 font-mono text-[11px] whitespace-pre-wrap break-all">
                        {r.error_message.slice(0, 200)}{r.error_message.length > 200 ? '…' : ''}
                      </code>
                    ) : r.status === 'processed' && r.processed_at && r.received_at ? (
                      <span className="text-[10px] text-slate-400">
                        processed in {Math.max(0, r.processed_at.getTime() - r.received_at.getTime())}ms
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="text-[11px] text-slate-500">
          Showing latest 200 events (filtered). For older events run a SQL query against{' '}
          <code className="font-mono">stripe_webhook_log</code> directly.
        </p>
      </div>
    </main>
  );
}

function fmtTimeAgo(d: Date): string {
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 7 * 86400) return `${Math.floor(sec / 86400)}d ago`;
  return d.toLocaleDateString();
}

function StatusBadge({ status }: { status: 'received' | 'processed' | 'failed' }) {
  const cfg =
    status === 'processed' ? { bg: 'bg-emerald-100', fg: 'text-emerald-800', label: 'processed' } :
    status === 'failed'    ? { bg: 'bg-rose-100',    fg: 'text-rose-800',    label: 'failed'    } :
                             { bg: 'bg-slate-100',   fg: 'text-slate-700',   label: 'received'  };
  return (
    <span className={`inline-block rounded-full ${cfg.bg} px-2 py-0.5 text-[10px] font-semibold ${cfg.fg}`}>
      {cfg.label}
    </span>
  );
}

function KpiCard({ label, value, accent }: { label: string; value: string; accent?: 'rose' | 'slate' }) {
  const cls = accent === 'rose' ? 'bg-rose-50 border-rose-200' : 'bg-white border-slate-200';
  return (
    <div className={`rounded-lg border ${cls} px-4 py-3`}>
      <div className="text-[11px] uppercase tracking-wide text-slate-500 font-medium">{label}</div>
      <div className="text-2xl font-bold text-slate-900 tabular-nums mt-0.5">{value}</div>
    </div>
  );
}

function FilterChip({ label, href, active }: { label: string; href: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`rounded-full px-3 py-1 text-xs font-medium border ${
        active
          ? 'bg-slate-900 text-white border-slate-900'
          : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
      }`}
    >
      {label}
    </Link>
  );
}
