// Overview tab — KPI cards + the most-recent activity. Pulls the same
// data as the PaymentsOverview widget, just rendered in the GHL-native
// embedded layout (white cards on light gray, blue accents).

import Link from 'next/link';
import { Banknote, AlertTriangle, CreditCard, CheckCircle2 } from 'lucide-react';
import { query } from '@/lib/db';
import { HelpCallout } from '@/components/HelpCallout';

export async function PaymentsHubOverview({
  schoolId, locationId,
}: { schoolId: string; locationId: string }) {
  const [collected, openInv, pastDue, autopay, recentPay, recentFail] = await Promise.all([
    query<{ mtd: string; ytd: string }>(
      `SELECT COALESCE(SUM(p.amount_cents) FILTER (WHERE p.created_at >= date_trunc('month', now())), 0)::text AS mtd,
              COALESCE(SUM(p.amount_cents) FILTER (WHERE p.created_at >= date_trunc('year', now())), 0)::text AS ytd
         FROM payments p
        WHERE p.school_id = $1 AND p.status = 'succeeded'`,
      [schoolId],
    ).then((r) => r.rows[0] ?? { mtd: '0', ytd: '0' }),
    query<{ n: string; total: string }>(
      `SELECT COUNT(*)::text AS n, COALESCE(SUM(total_cents - amount_paid_cents), 0)::text AS total
         FROM invoices WHERE school_id = $1 AND status IN ('open', 'partially_paid')`,
      [schoolId],
    ).then((r) => r.rows[0] ?? { n: '0', total: '0' }),
    query<{ n: string; total: string }>(
      `SELECT COUNT(*)::text AS n, COALESCE(SUM(total_cents - amount_paid_cents), 0)::text AS total
         FROM invoices i WHERE i.school_id = $1 AND i.status IN ('open', 'partially_paid') AND i.due_at < now()
           -- exclude invoices with a payment already in flight (ACH clearing) —
           -- they're on their way, not past due.
           AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id AND p.status IN ('pending', 'processing'))`,
      [schoolId],
    ).then((r) => r.rows[0] ?? { n: '0', total: '0' }),
    query<{ enrolled: string; total: string }>(
      `WITH open_fams AS (
         SELECT DISTINCT family_id FROM invoices WHERE school_id = $1 AND status IN ('open', 'partially_paid')
       ), autopay_fams AS (
         SELECT DISTINCT family_id FROM invoices WHERE school_id = $1
           AND autopay_enabled = true AND status IN ('open', 'partially_paid')
       )
       SELECT (SELECT COUNT(*) FROM autopay_fams)::text AS enrolled,
              (SELECT COUNT(*) FROM open_fams)::text   AS total`,
      [schoolId],
    ).then((r) => r.rows[0] ?? { enrolled: '0', total: '0' }),
    query<{
      id: string; invoice_number: string; family_label: string;
      amount_cents: number; method_type: string | null; succeeded_at: string;
    }>(
      `SELECT p.id, i.invoice_number,
              COALESCE(NULLIF(f.display_name, ''),
                       CONCAT_WS(' ', pl.first_name, pl.last_name),
                       '(unnamed)') AS family_label,
              p.amount_cents, p.stripe_payment_method_type AS method_type,
              p.updated_at AS succeeded_at
         FROM payments p
         JOIN invoices i ON i.id = p.invoice_id
         JOIN families f ON f.id = p.family_id
         LEFT JOIN LATERAL (
           SELECT first_name, last_name FROM parents
            WHERE family_id = f.id AND is_primary = true LIMIT 1
         ) pl ON true
        WHERE p.school_id = $1 AND p.status = 'succeeded'
        ORDER BY p.updated_at DESC LIMIT 8`,
      [schoolId],
    ).then((r) => r.rows),
    query<{
      id: string; invoice_number: string; family_label: string;
      amount_cents: number; failure_message: string | null; failed_at: string;
    }>(
      `SELECT p.id, i.invoice_number,
              COALESCE(NULLIF(f.display_name, ''),
                       CONCAT_WS(' ', pl.first_name, pl.last_name),
                       '(unnamed)') AS family_label,
              p.amount_cents, p.failure_message, p.updated_at AS failed_at
         FROM payments p
         JOIN invoices i ON i.id = p.invoice_id
         JOIN families f ON f.id = p.family_id
         LEFT JOIN LATERAL (
           SELECT first_name, last_name FROM parents
            WHERE family_id = f.id AND is_primary = true LIMIT 1
         ) pl ON true
        WHERE p.school_id = $1 AND p.status = 'failed'
          AND p.updated_at >= now() - interval '30 days'
        ORDER BY p.updated_at DESC LIMIT 5`,
      [schoolId],
    ).then((r) => r.rows),
  ]);

  const autopayPct = Number(autopay.total) > 0
    ? Math.round((Number(autopay.enrolled) / Number(autopay.total)) * 100)
    : 0;

  return (
    <div className="space-y-4">
      <HelpCallout
        title="What you're looking at"
        defaultOpen={false}
        steps={[
          <>The four cards at the top show your real-time money flow: cash collected this month/YTD, open invoices, anything past-due, and how many families are on autopay.</>,
          <>Below those, the left pane lists the <strong>most recent successful payments</strong>; the right pane lists any <strong>failed payments in the last 30 days</strong> so you can chase them.</>,
          <>Click the Past-due card to jump to a filtered invoice list. Click any invoice number anywhere on this hub to see its full detail.</>,
          <>This is your dedicated Growth Suite payments hub — everything here pulls from your Stripe Connect account, with school-specific context (tuition plans, autopay, etc.) layered on top.</>,
        ]}
      />

      {/* KPI cards — visually match GHL's stat-card style */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KPICard
          label="Collected this month"
          value={fmtMoney(collected.mtd)}
          sublabel={`YTD: ${fmtMoney(collected.ytd)}`}
          icon={<Banknote className="h-4 w-4 text-emerald-600" />}
        />
        <KPICard
          label="Open invoices"
          value={String(openInv.n)}
          sublabel={`${fmtMoney(openInv.total)} outstanding`}
          icon={<CreditCard className="h-4 w-4 text-slate-600" />}
          href={`/school/${locationId}/payments?tab=invoices`}
        />
        <KPICard
          label="Past due"
          value={String(pastDue.n)}
          sublabel={`${fmtMoney(pastDue.total)} overdue`}
          tone={Number(pastDue.n) > 0 ? 'warn' : 'neutral'}
          icon={<AlertTriangle className="h-4 w-4 text-amber-600" />}
        />
        <KPICard
          label="Autopay enrolled"
          value={`${autopayPct}%`}
          sublabel={`${autopay.enrolled} of ${autopay.total} families`}
          tone={autopayPct >= 60 ? 'good' : 'neutral'}
          icon={<CheckCircle2 className="h-4 w-4 text-emerald-600" />}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Recent payments */}
        <section className="rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-4 py-2.5 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">Recent payments</h2>
            <Link href={`/school/${locationId}/payments?tab=invoices`} className="text-xs text-blue-600 hover:text-blue-800">View all →</Link>
          </div>
          {recentPay.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-slate-500 italic">No payments yet.</div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {recentPay.map((p) => (
                <li key={p.id} className="px-4 py-2 flex items-center justify-between gap-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="text-slate-900 truncate">{p.family_label}</div>
                    <div className="text-[10px] text-slate-500 font-mono">{p.invoice_number}</div>
                  </div>
                  <div className="text-right whitespace-nowrap">
                    <div className="font-mono text-emerald-700 text-sm">${(p.amount_cents / 100).toFixed(2)}</div>
                    <div className="text-[10px] text-slate-500">{fmtDate(p.succeeded_at)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Recent failures */}
        <section className="rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-4 py-2.5">
            <h2 className="text-sm font-semibold text-slate-900">Failed payments — last 30 days</h2>
          </div>
          {recentFail.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-slate-500 italic">No payment failures. Nice.</div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {recentFail.map((p) => (
                <li key={p.id} className="px-4 py-2 flex items-center justify-between gap-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="text-slate-900 truncate">{p.family_label}</div>
                    {p.failure_message ? (
                      <div className="text-[11px] text-amber-700 truncate" title={p.failure_message}>
                        {p.failure_message}
                      </div>
                    ) : null}
                  </div>
                  <div className="text-right whitespace-nowrap">
                    <div className="font-mono text-slate-900 text-sm">${(p.amount_cents / 100).toFixed(2)}</div>
                    <div className="text-[10px] text-slate-500">{fmtDate(p.failed_at)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function KPICard({
  label, value, sublabel, icon, tone, href,
}: {
  label: string; value: string; sublabel: string; icon: React.ReactNode;
  tone?: 'good' | 'warn' | 'neutral'; href?: string;
}) {
  const toneClass = tone === 'good' ? 'border-emerald-200 bg-emerald-50/30'
                  : tone === 'warn' ? 'border-amber-200 bg-amber-50/30'
                                    : 'border-slate-200 bg-white';
  const body = (
    <>
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-[11px] uppercase tracking-wide text-slate-500 font-medium">{label}</div>
        {icon}
      </div>
      <div className="text-2xl font-semibold text-slate-900 tabular-nums">{value}</div>
      <div className="text-[11px] text-slate-500 tabular-nums mt-0.5">{sublabel}</div>
    </>
  );
  return href ? (
    <Link href={href} className={`block rounded-lg border ${toneClass} p-3.5 hover:border-blue-400 hover:shadow-sm transition`}>{body}</Link>
  ) : (
    <div className={`rounded-lg border ${toneClass} p-3.5`}>{body}</div>
  );
}

function fmtMoney(cents: string): string {
  const n = Number(cents) / 100;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(s: string): string {
  const d = new Date(s);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
