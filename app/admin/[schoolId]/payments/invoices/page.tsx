// /admin/[schoolId]/payments/invoices — list + create

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Receipt, Plus, Search } from 'lucide-react';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type Params = Promise<{ schoolId: string }>;
type SearchParams = Promise<{
  msg?: string; err?: string; family?: string;
  q?: string; status?: string; source?: string;
}>;

interface InvoiceRow {
  id: string;
  invoice_number: string;
  title: string;
  status: string;
  total_cents: number;
  amount_paid_cents: number;
  due_at: string;
  family_label: string;
  created_at: string;
}

export default async function InvoicesIndex({
  params, searchParams,
}: { params: Params; searchParams: SearchParams }) {
  const { schoolId } = await params;
  const sp = await searchParams;

  const { rows: schoolRows } = await query<{ id: string; name: string }>(
    `SELECT id, name FROM schools WHERE id = $1`, [schoolId],
  );
  if (schoolRows.length === 0) notFound();
  const school = schoolRows[0];

  // Filters
  const search = (sp.q ?? '').trim();
  const statusFilter = (sp.status ?? '').trim();
  const sourceFilter = (sp.source ?? '').trim();
  const validStatuses = new Set(['draft', 'open', 'paid', 'partially_paid', 'voided', 'refunded', 'partially_refunded']);
  const validSources = new Set(['manual', 'form_submission', 'tuition_plan', 'enrollment_deposit', 'autopay_installment']);

  const conds: string[] = ['i.school_id = $1'];
  const args: unknown[] = [schoolId];
  if (search) {
    args.push(`%${search}%`);
    const placeholder = `$${args.length}`;
    conds.push(`(
      i.invoice_number ILIKE ${placeholder}
      OR i.title ILIKE ${placeholder}
      OR f.display_name ILIKE ${placeholder}
      OR EXISTS (SELECT 1 FROM parents pp
                  WHERE pp.family_id = i.family_id
                    AND (pp.first_name ILIKE ${placeholder}
                      OR pp.last_name  ILIKE ${placeholder}
                      OR pp.email      ILIKE ${placeholder}))
    )`);
  }
  if (statusFilter && validStatuses.has(statusFilter)) {
    args.push(statusFilter);
    conds.push(`i.status = $${args.length}`);
  }
  if (sourceFilter && validSources.has(sourceFilter)) {
    args.push(sourceFilter);
    conds.push(`i.source = $${args.length}`);
  }

  const { rows: invoices } = await query<InvoiceRow>(
    `SELECT i.id, i.invoice_number, i.title, i.status,
            i.total_cents, i.amount_paid_cents, i.due_at,
            COALESCE(NULLIF(f.display_name, ''),
                     CONCAT_WS(' ', p.first_name, p.last_name),
                     '(unnamed)') AS family_label,
            i.created_at
       FROM invoices i
       JOIN families f ON f.id = i.family_id
       LEFT JOIN LATERAL (
         SELECT first_name, last_name FROM parents
         WHERE family_id = i.family_id AND is_primary = true LIMIT 1
       ) p ON true
      WHERE ${conds.join(' AND ')}
      ORDER BY i.created_at DESC
      LIMIT 200`,
    args,
  );

  const isFiltered = !!(search || statusFilter || sourceFilter);

  return (
    <main className="flex flex-1 flex-col items-center bg-zinc-50 p-6 dark:bg-black">
      <div className="w-full max-w-5xl space-y-4">
        <Link href={`/admin/${schoolId}/payments`} className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-700">
          <ArrowLeft className="h-3 w-3" /> Payments
        </Link>

        <div className="flex items-baseline justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-900">Invoices</h1>
            <p className="text-xs text-zinc-500">
              {school.name} · showing {invoices.length}
              {isFiltered ? ' (filtered)' : ' most recent'}
            </p>
          </div>
          <Link
            href={`/admin/${schoolId}/payments/invoices/new`}
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-800"
          >
            <Plus className="h-3.5 w-3.5" /> Create invoice
          </Link>
        </div>

        {sp.msg ? (
          <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{sp.msg}</div>
        ) : null}
        {sp.err ? (
          <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{sp.err}</div>
        ) : null}

        {/* Filter row */}
        <form method="GET" className="flex flex-wrap items-center gap-2 rounded-xl border border-black/10 bg-white p-3">
          <div className="relative min-w-[16rem] flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-400" />
            <input
              type="search" name="q" defaultValue={search}
              placeholder="Search invoice #, title, family, parent name/email…"
              className="w-full rounded-md border border-zinc-300 bg-white pl-7 pr-3 py-1.5 text-sm focus:border-emerald-600 focus:outline-none"
            />
          </div>
          <label className="text-xs text-zinc-600">
            Status:{' '}
            <select name="status" defaultValue={statusFilter} className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm">
              <option value="">all</option>
              <option value="open">open</option>
              <option value="partially_paid">partial</option>
              <option value="paid">paid</option>
              <option value="draft">draft</option>
              <option value="voided">voided</option>
              <option value="refunded">refunded</option>
            </select>
          </label>
          <label className="text-xs text-zinc-600">
            Source:{' '}
            <select name="source" defaultValue={sourceFilter} className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm">
              <option value="">all</option>
              <option value="manual">manual</option>
              <option value="form_submission">form</option>
              <option value="tuition_plan">tuition plan</option>
              <option value="autopay_installment">autopay</option>
            </select>
          </label>
          <button type="submit" className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-800">
            Apply
          </button>
          {isFiltered ? (
            <Link href={`/admin/${schoolId}/payments/invoices`} className="text-xs text-zinc-500 hover:underline">
              clear
            </Link>
          ) : null}
        </form>

        <div className="rounded-xl border border-black/10 bg-white overflow-hidden">
          {invoices.length === 0 ? (
            <div className="p-12 text-center">
              <Receipt className="mx-auto h-10 w-10 text-zinc-300 mb-2" />
              <p className="text-sm text-zinc-600">
                {isFiltered ? 'No invoices match the current filters.' : 'No invoices yet.'}
              </p>
              {!isFiltered ? (
                <p className="text-xs text-zinc-500 mt-1">Click <strong>Create invoice</strong> to bill a family.</p>
              ) : null}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 border-b border-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="px-3 py-2 font-medium">Invoice #</th>
                  <th className="px-3 py-2 font-medium">Family</th>
                  <th className="px-3 py-2 font-medium">Title</th>
                  <th className="px-3 py-2 font-medium text-center">Status</th>
                  <th className="px-3 py-2 font-medium text-right">Amount</th>
                  <th className="px-3 py-2 font-medium">Due</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {invoices.map((inv) => (
                  <tr key={inv.id} className="hover:bg-zinc-50">
                    <td className="px-3 py-2">
                      <Link href={`/admin/${schoolId}/payments/invoices/${inv.id}`} className="font-mono text-xs font-medium text-emerald-700 hover:underline">
                        {inv.invoice_number}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-zinc-900">{inv.family_label}</td>
                    <td className="px-3 py-2 text-zinc-700">{inv.title}</td>
                    <td className="px-3 py-2 text-center"><StatusPill status={inv.status} /></td>
                    <td className="px-3 py-2 text-right font-mono">
                      ${(inv.total_cents / 100).toFixed(2)}
                      {inv.amount_paid_cents > 0 && inv.amount_paid_cents < inv.total_cents ? (
                        <span className="ml-1 text-[10px] text-amber-700">(${(inv.amount_paid_cents / 100).toFixed(2)} paid)</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-xs text-zinc-500">
                      {new Date(inv.due_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </main>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { bg: string; fg: string; label: string }> = {
    draft:              { bg: 'bg-zinc-100', fg: 'text-zinc-700', label: 'Draft' },
    open:               { bg: 'bg-amber-100', fg: 'text-amber-800', label: 'Open' },
    paid:               { bg: 'bg-emerald-100', fg: 'text-emerald-800', label: 'Paid' },
    partially_paid:     { bg: 'bg-amber-100', fg: 'text-amber-800', label: 'Partial' },
    voided:             { bg: 'bg-zinc-100', fg: 'text-zinc-500', label: 'Voided' },
    refunded:           { bg: 'bg-red-100', fg: 'text-red-800', label: 'Refunded' },
    partially_refunded: { bg: 'bg-red-100', fg: 'text-red-800', label: 'Partial Refund' },
  };
  const cfg = map[status] ?? { bg: 'bg-zinc-100', fg: 'text-zinc-700', label: status };
  return (
    <span className={`rounded-full ${cfg.bg} px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${cfg.fg}`}>
      {cfg.label}
    </span>
  );
}
