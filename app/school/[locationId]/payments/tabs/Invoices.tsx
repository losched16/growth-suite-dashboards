// Invoices tab — list of invoices with the same filter UI as the
// /admin/.../payments/invoices page, but styled for GHL embed.

import Link from 'next/link';
import { Plus, Search } from 'lucide-react';
import { query } from '@/lib/db';
import { HelpCallout } from '@/components/HelpCallout';
import { CreditAddForm } from './CreditAddForm';

export async function PaymentsHubInvoices({
  schoolId, locationId, q = '', statusFilter = '',
}: { schoolId: string; locationId: string; q?: string; statusFilter?: string }) {
  const { rows: allInvoices } = await query<{
    id: string;
    invoice_number: string;
    title: string;
    status: string;
    total_cents: number;
    amount_paid_cents: number;
    due_at: string;
    family_label: string;
    student_label: string | null;
    source: string;
    created_at: string;
    has_pending_payment: boolean;
  }>(
    `SELECT i.id, i.invoice_number, i.title, i.status,
            i.total_cents, i.amount_paid_cents, i.due_at, i.source, i.created_at,
            EXISTS (SELECT 1 FROM payments pmt WHERE pmt.invoice_id = i.id
                      AND pmt.status IN ('pending', 'processing')) AS has_pending_payment,
            COALESCE(NULLIF(f.display_name, ''),
                     CONCAT_WS(' ', p.first_name, p.last_name),
                     i.recipient_name, i.recipient_email,
                     '(unnamed)') AS family_label,
            CASE WHEN i.student_id IS NULL THEN NULL
                 ELSE CONCAT_WS(' ', COALESCE(NULLIF(st.preferred_name, ''), st.first_name), st.last_name) END AS student_label
       FROM invoices i
       LEFT JOIN families f ON f.id = i.family_id
       LEFT JOIN students st ON st.id = i.student_id
       LEFT JOIN LATERAL (
         SELECT first_name, last_name FROM parents
          WHERE family_id = i.family_id AND is_primary = true LIMIT 1
       ) p ON true
      WHERE i.school_id = $1
      ORDER BY i.due_at ASC
      LIMIT 500`,
    [schoolId],
  );

  // Search + status filter (incl. the synthetic 'overdue' status).
  const now = Date.now();
  // An invoice with a payment already in flight (ACH sits 'pending' for a few
  // business days) is NOT overdue — it's clearing. Only flag genuinely-unpaid,
  // past-due invoices so the office isn't chasing a payment that's on its way.
  const isOverdue = (inv: typeof allInvoices[number]) =>
    (inv.status === 'open' || inv.status === 'partially_paid')
    && new Date(inv.due_at).getTime() < now
    && !inv.has_pending_payment;
  const needle = q.trim().toLowerCase();
  const invoices = allInvoices.filter((inv) => {
    if (needle && !(`${inv.invoice_number} ${inv.family_label} ${inv.student_label ?? ''} ${inv.title}`.toLowerCase().includes(needle))) return false;
    if (statusFilter === 'overdue') return isOverdue(inv);
    if (statusFilter && inv.status !== statusFilter) return false;
    return true;
  });
  const daysLate = (inv: typeof allInvoices[number]) =>
    Math.floor((now - new Date(inv.due_at).getTime()) / 86_400_000);

  // Family credits: families for the add form + outstanding balances.
  const { rows: familyOptions } = await query<{ id: string; label: string }>(
    `SELECT f.id,
            COALESCE(NULLIF(f.display_name, ''), CONCAT_WS(' ', p.first_name, p.last_name), '(unnamed)') AS label
       FROM families f
       LEFT JOIN LATERAL (SELECT first_name, last_name FROM parents WHERE family_id = f.id AND is_primary = true LIMIT 1) p ON true
      WHERE f.school_id = $1 AND f.status = 'active'
      ORDER BY label LIMIT 500`,
    [schoolId],
  );
  const { rows: creditStudentRows } = await query<{ family_id: string; id: string; name: string }>(
    `SELECT family_id, id, CONCAT_WS(' ', COALESCE(NULLIF(preferred_name, ''), first_name), last_name) AS name
       FROM students WHERE school_id = $1 AND status = 'active' ORDER BY first_name`,
    [schoolId],
  );
  const creditStudentsByFamily: Record<string, Array<{ id: string; name: string }>> = {};
  for (const s of creditStudentRows) (creditStudentsByFamily[s.family_id] ??= []).push({ id: s.id, name: s.name });
  // Balances grouped per family + per attributed student, so the list
  // reads "Smith — Ada Smith: $120 / family: $50".
  const { rows: creditBalances } = await query<{ family_id: string; label: string; student_name: string | null; remaining: number }>(
    `SELECT fc.family_id,
            COALESCE(NULLIF(f.display_name, ''), '(unnamed)') AS label,
            CASE WHEN fc.student_id IS NULL THEN NULL
                 ELSE CONCAT_WS(' ', COALESCE(NULLIF(s.preferred_name, ''), s.first_name), s.last_name) END AS student_name,
            SUM(fc.remaining_cents)::int AS remaining
       FROM family_credits fc
       JOIN families f ON f.id = fc.family_id
       LEFT JOIN students s ON s.id = fc.student_id
      WHERE fc.school_id = $1 AND fc.remaining_cents > 0
      GROUP BY 1, 2, 3 ORDER BY remaining DESC`,
    [schoolId],
  );

  // KPI strip — computed over ALL invoices so the cards stay stable
  // while the table below is filtered.
  const kpi = allInvoices.reduce((acc, inv) => {
    const owed = inv.total_cents - inv.amount_paid_cents;
    if (inv.status === 'draft') { acc.draftN += 1; acc.draftTotal += inv.total_cents; }
    else if (inv.status === 'open' || inv.status === 'partially_paid') {
      acc.dueN += 1; acc.dueTotal += owed;
      if (new Date(inv.due_at) < new Date() && !inv.has_pending_payment) { acc.overdueN += 1; acc.overdueTotal += owed; }
    } else if (inv.status === 'paid') {
      acc.paidN += 1; acc.paidTotal += inv.amount_paid_cents;
    }
    return acc;
  }, { draftN: 0, draftTotal: 0, dueN: 0, dueTotal: 0, paidN: 0, paidTotal: 0, overdueN: 0, overdueTotal: 0 });

  return (
    <div className="space-y-4">
      {/* Header strip with title + New CTA — visually mirrors GHL */}
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Invoices</h2>
          <p className="text-sm text-slate-500">Create and manage all invoices for your school.</p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/school/${locationId}/payments/invoices/bulk`}
            className="inline-flex items-center gap-1.5 rounded-md border-2 border-blue-600 bg-white px-4 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50"
          >
            Bulk invoice
          </Link>
          <Link
            href={`/school/${locationId}/payments/invoices/new`}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" /> New invoice
          </Link>
        </div>
      </div>

      <HelpCallout
        title="How invoices work here"
        defaultOpen={false}
        steps={[
          <>Invoices are created automatically when a tuition plan starts (one per installment) or manually via <strong>New invoice</strong>.</>,
          <>The four cards across the top tally <strong>drafts</strong>, <strong>amount due</strong>, <strong>amount received</strong>, and anything <strong>overdue</strong>. Overdue is calculated against each invoice&apos;s due date.</>,
          <>Use the search box to find an invoice by number, family name, or parent name. Click any invoice number to view it.</>,
          <>The <strong>Source</strong> column tells you where the invoice came from: a tuition plan, a manual create, an enrollment deposit, or an autopay run.</>,
        ]}
      />

      {/* GHL-style KPI strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KPICard label={`${kpi.draftN} Invoice(s) in Draft`}    value={fmt(kpi.draftTotal)} />
        <KPICard label={`${kpi.dueN} Invoice(s) in Due`}        value={fmt(kpi.dueTotal)} />
        <KPICard label={`${kpi.paidN} Invoice(s) received`}     value={fmt(kpi.paidTotal)} />
        <Link href={`/school/${locationId}/payments?tab=invoices&status=overdue`} className="block">
          <KPICard label={`${kpi.overdueN} Invoice(s) Overdue`}   value={fmt(kpi.overdueTotal)} tone={kpi.overdueN > 0 ? 'warn' : undefined} />
        </Link>
      </div>

      {/* Filter bar */}
      <form method="GET" className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white p-3">
        <input type="hidden" name="tab" value="invoices" />
        <div className="relative min-w-[16rem] flex-1">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
          <input
            type="search" name="q" defaultValue={q} placeholder="Search invoice #, family, parent…"
            className="w-full rounded-md border border-slate-300 bg-white pl-7 pr-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>
        <select name="status" defaultValue={statusFilter} className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm">
          <option value="">All statuses</option>
          <option value="overdue">⚠ Overdue</option>
          <option value="open">Open</option>
          <option value="partially_paid">Partially paid</option>
          <option value="paid">Paid</option>
          <option value="draft">Draft</option>
          <option value="voided">Voided</option>
        </select>
        <button type="submit" className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700">
          Search
        </button>
        {(q || statusFilter) ? (
          <Link href={`/school/${locationId}/payments?tab=invoices`} className="text-xs text-slate-500 hover:underline">clear</Link>
        ) : null}
      </form>

      {/* Table */}
      <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-100 text-left text-[10px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2.5 font-medium">Invoice #</th>
              <th className="px-4 py-2.5 font-medium">Family</th>
              <th className="px-4 py-2.5 font-medium">Title</th>
              <th className="px-4 py-2.5 font-medium text-center">Status</th>
              <th className="px-4 py-2.5 font-medium text-right">Amount</th>
              <th className="px-4 py-2.5 font-medium">Due</th>
              <th className="px-4 py-2.5 font-medium">Source</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {invoices.length === 0 ? (
              <tr><td colSpan={7} className="p-10 text-center text-sm text-slate-500 italic">No invoices yet.</td></tr>
            ) : invoices.map((inv) => (
              <tr key={inv.id} className="hover:bg-slate-50">
                <td className="px-4 py-2">
                  {/*
                    prefetch={false}: this table can render ~100 rows
                    and Next.js prefetches each Link on viewport entry.
                    That used to fire ~100 concurrent RSC fetches
                    against /admin/.../payments/invoices/<id> and burn
                    through the upstream DB pool. Each row is a one-off
                    drill-down click, so prefetching them is wasted
                    work anyway.
                  */}
                  <Link href={`/school/${locationId}/payments/invoices/${inv.id}`} prefetch={false} className="font-mono text-xs font-medium text-blue-600 hover:underline">
                    {inv.invoice_number}
                  </Link>
                </td>
                <td className="px-4 py-2 text-slate-900">
                  {inv.family_label}
                  {inv.student_label ? (
                    <div className="text-[11px] text-slate-500">{inv.student_label}</div>
                  ) : null}
                </td>
                <td className="px-4 py-2 text-slate-700">{inv.title}</td>
                <td className="px-4 py-2 text-center"><StatusPill status={inv.status} /></td>
                <td className="px-4 py-2 text-right font-mono">
                  ${(inv.total_cents / 100).toFixed(2)}
                  {inv.amount_paid_cents > 0 && inv.amount_paid_cents < inv.total_cents ? (
                    <span className="ml-1 text-[10px] text-amber-700">(${(inv.amount_paid_cents / 100).toFixed(2)} paid)</span>
                  ) : null}
                </td>
                <td className="px-4 py-2 text-xs text-slate-500 whitespace-nowrap">
                  {new Date(inv.due_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                  {inv.has_pending_payment ? (
                    <span className="ml-1.5 inline-block rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800">
                      processing
                    </span>
                  ) : isOverdue(inv) ? (
                    <span className="ml-1.5 inline-block rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold text-rose-800">
                      {daysLate(inv)}d late
                    </span>
                  ) : null}
                </td>
                <td className="px-4 py-2 text-xs">
                  <SourceBadge source={inv.source} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Family credits — issue account credits + see outstanding
          balances. Credits apply to invoices from the invoice detail
          page ("Apply credit"). */}
      <div className="rounded-lg border border-emerald-200 bg-white overflow-hidden">
        <div className="border-b border-emerald-100 bg-emerald-50/40 px-4 py-2.5 text-sm font-semibold text-emerald-900">
          Family credits
        </div>
        <div className="p-4 grid grid-cols-1 lg:grid-cols-2 gap-5">
          <CreditAddForm
            schoolId={schoolId}
            returnTo={`/school/${locationId}/payments?tab=invoices`}
            familyOptions={familyOptions}
            studentsByFamily={creditStudentsByFamily}
          />
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-600 mb-2">
              Outstanding credit balances ({creditBalances.length})
            </div>
            {creditBalances.length === 0 ? (
              <p className="text-sm text-slate-500 italic">No families currently hold credit.</p>
            ) : (
              <ul className="divide-y divide-slate-100 max-h-56 overflow-y-auto">
                {creditBalances.map((c, i) => (
                  <li key={`${c.family_id}-${c.student_name ?? 'family'}-${i}`} className="flex items-center justify-between py-1.5 text-sm">
                    <span className="text-slate-900">
                      {c.label}
                      {c.student_name
                        ? <span className="ml-1.5 text-xs text-slate-500">· {c.student_name}</span>
                        : <span className="ml-1.5 text-xs text-slate-400">· family</span>}
                    </span>
                    <span className="font-mono font-semibold text-emerald-700">${(c.remaining / 100).toFixed(2)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function KPICard({ label, value, tone }: { label: string; value: string; tone?: 'warn' }) {
  const cls = tone === 'warn' ? 'border-amber-200 bg-amber-50/30' : 'border-slate-200 bg-white';
  return (
    <div className={`rounded-lg border ${cls} p-4`}>
      <div className="text-xs text-slate-500 mb-1.5">{label}</div>
      <div className="text-2xl font-semibold text-slate-900 tabular-nums">{value}</div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { bg: string; fg: string; label: string }> = {
    draft:              { bg: 'bg-slate-100',    fg: 'text-slate-700',    label: 'Draft' },
    open:               { bg: 'bg-amber-100',    fg: 'text-amber-800',    label: 'Open' },
    paid:               { bg: 'bg-emerald-100',  fg: 'text-emerald-800',  label: 'Paid' },
    partially_paid:     { bg: 'bg-amber-100',    fg: 'text-amber-800',    label: 'Partial' },
    voided:             { bg: 'bg-slate-100',    fg: 'text-slate-500',    label: 'Voided' },
    refunded:           { bg: 'bg-red-100',      fg: 'text-red-800',      label: 'Refunded' },
    partially_refunded: { bg: 'bg-red-100',      fg: 'text-red-800',      label: 'Partial Refund' },
  };
  const cfg = map[status] ?? { bg: 'bg-slate-100', fg: 'text-slate-700', label: status };
  return (
    <span className={`rounded-full ${cfg.bg} px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${cfg.fg}`}>
      {cfg.label}
    </span>
  );
}

function SourceBadge({ source }: { source: string }) {
  const map: Record<string, string> = {
    manual: 'Manual',
    form_submission: 'Form',
    tuition_plan: 'Plan',
    enrollment_deposit: 'Deposit',
    autopay_installment: 'Autopay',
  };
  return <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600 uppercase tracking-wide text-[10px]">{map[source] ?? source}</span>;
}

function fmt(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
