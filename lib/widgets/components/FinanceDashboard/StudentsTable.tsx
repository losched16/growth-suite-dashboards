'use client';

// Students & Families table with an inline accordion. Click a student row
// to expand their full FACTS account history + Growth Suite payment
// schedule + progress, without leaving the page. One row open at a time
// (local state), matching the FamilyHub accordion convention.

import { useState, Fragment } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import Link from 'next/link';
import type { StudentProgressRow } from './fetcher';

const fmt = (n: number) =>
  n === 0 ? '$0.00' : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function StudentsTable({ rows, locationId }: { rows: StudentProgressRow[]; locationId: string }) {
  const [open, setOpen] = useState<string | null>(null);

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-500">
        No students match.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-b border-gray-100 text-left text-[11px] uppercase tracking-wide text-gray-500">
          <tr>
            <th className="w-6 px-2 py-2" />
            <th className="px-3 py-2 font-medium">Student</th>
            <th className="px-3 py-2 font-medium">Family</th>
            <th className="px-3 py-2 font-medium">Plan</th>
            <th className="px-3 py-2 font-medium text-right">Charged</th>
            <th className="px-3 py-2 font-medium text-right">Paid</th>
            <th className="px-3 py-2 font-medium text-right">Balance</th>
            <th className="px-3 py-2 font-medium">Progress</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((r) => {
            const isOpen = open === r.student_id;
            return (
              <Fragment key={r.student_id}>
                <tr
                  className="cursor-pointer hover:bg-gray-50"
                  onClick={() => setOpen(isOpen ? null : r.student_id)}
                >
                  <td className="px-2 py-2 text-gray-400">
                    {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </td>
                  <td className="px-3 py-2 font-medium text-gray-900">
                    {r.student_name}
                    {(r.unique_id || r.program) ? (
                      <div className="text-[11px] text-gray-500">
                        {r.unique_id ? <span className="tabular-nums">ID {r.unique_id}</span> : null}
                        {r.unique_id && r.program ? ' · ' : ''}
                        {r.program || ''}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-gray-700">{r.family}</td>
                  <td className="px-3 py-2 text-xs text-gray-600">
                    {r.plan || '—'}
                    {r.gs_installments > 0 ? <span className="text-gray-400"> · {r.gs_installments} pmts</span> : null}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-700">{fmt(r.charged)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-emerald-700">{fmt(r.paid)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums font-semibold ${r.balance > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>{fmt(r.balance)}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-20 rounded-full bg-gray-200 overflow-hidden">
                        <div className="h-full bg-emerald-500" style={{ width: `${r.pct_paid}%` }} />
                      </div>
                      <span className="text-[11px] text-gray-500 tabular-nums">{r.pct_paid}%</span>
                    </div>
                  </td>
                </tr>
                {isOpen ? (
                  <tr className="bg-gray-50/60">
                    <td colSpan={8} className="px-4 py-3">
                      <StudentDetail row={r} locationId={locationId} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function StudentDetail({ row, locationId }: { row: StudentProgressRow; locationId: string }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
        <span className="text-gray-600">Charged <strong className="text-gray-900 tabular-nums">{fmt(row.charged)}</strong></span>
        <span className="text-gray-600">Credits <strong className="text-gray-900 tabular-nums">{fmt(row.credits)}</strong></span>
        <span className="text-gray-600">Paid <strong className="text-emerald-700 tabular-nums">{fmt(row.paid)}</strong></span>
        <span className="text-gray-600">Balance <strong className={`tabular-nums ${row.balance > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>{fmt(row.balance)}</strong></span>
        <span className="ml-auto flex items-center gap-2">
          <div className="h-2 w-32 rounded-full bg-gray-200 overflow-hidden">
            <div className="h-full bg-emerald-500" style={{ width: `${row.pct_paid}%` }} />
          </div>
          <span className="text-xs text-gray-600 tabular-nums">{row.pct_paid}% paid</span>
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* FACTS account history */}
        <div className="rounded-md border border-gray-200 bg-white overflow-hidden">
          <div className="border-b border-gray-100 bg-gray-50 px-3 py-1.5 text-xs font-semibold text-gray-700">
            Account history (FACTS — charges &amp; payments to date)
          </div>
          <table className="w-full text-xs">
            <thead className="text-left text-[10px] uppercase tracking-wide text-gray-400">
              <tr>
                <th className="px-3 py-1.5 font-medium">FACTS account</th>
                <th className="px-3 py-1.5 font-medium text-right">Charged</th>
                <th className="px-3 py-1.5 font-medium text-right">Credit</th>
                <th className="px-3 py-1.5 font-medium text-right">Paid</th>
                <th className="px-3 py-1.5 font-medium text-right">Balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {row.accounts.length === 0 ? (
                <tr><td colSpan={5} className="px-3 py-3 text-center text-gray-400">No FACTS history</td></tr>
              ) : row.accounts.map((a, i) => (
                <tr key={i}>
                  <td className="px-3 py-1.5 text-gray-700">{a.account}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-gray-600">{a.charged ? fmt(a.charged) : '—'}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">{a.credit ? fmt(a.credit) : '—'}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-emerald-700">{a.paid ? fmt(a.paid) : '—'}</td>
                  <td className={`px-3 py-1.5 text-right tabular-nums font-medium ${a.balance > 0 ? 'text-amber-700' : 'text-gray-400'}`}>{a.balance ? fmt(a.balance) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Growth Suite payment schedule */}
        <div className="rounded-md border border-gray-200 bg-white overflow-hidden">
          <div className="border-b border-gray-100 bg-gray-50 px-3 py-1.5 text-xs font-semibold text-gray-700 flex items-center justify-between gap-2">
            <span>Payment schedule (Growth Suite)</span>
            <span className="text-[10px] font-normal text-gray-400">
              {row.gs_installments} payments{row.gs_first_due ? ` · first ${row.gs_first_due}` : ''}
            </span>
          </div>
          <table className="w-full text-xs">
            <thead className="text-left text-[10px] uppercase tracking-wide text-gray-400">
              <tr>
                <th className="px-3 py-1.5 font-medium">Invoice</th>
                <th className="px-3 py-1.5 font-medium">Due</th>
                <th className="px-3 py-1.5 font-medium text-right">Amount</th>
                <th className="px-3 py-1.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {row.schedule.length === 0 ? (
                <tr><td colSpan={4} className="px-3 py-3 text-center text-gray-400">No schedule yet</td></tr>
              ) : row.schedule.map((s, i) => (
                <tr key={i}>
                  <td className="px-3 py-1.5 text-gray-600">{s.label}</td>
                  <td className="px-3 py-1.5 text-gray-600">{s.due ?? '—'}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-gray-700">{fmt(s.amount)}</td>
                  <td className="px-3 py-1.5">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                      s.status === 'Paid' ? 'bg-emerald-100 text-emerald-800'
                        : s.status === 'Partial' ? 'bg-amber-100 text-amber-800'
                        : 'bg-gray-100 text-gray-600'
                    }`}>{s.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {row.family_id ? (
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          <Link href={`/school/${locationId}/families/${row.family_id}/statement`} className="inline-block text-xs font-medium text-emerald-700 hover:underline">
            View account statement &amp; schedule →
          </Link>
          <Link href={`/school/${locationId}/family-hub/${row.family_id}`} className="inline-block text-xs text-emerald-700 hover:underline">
            Open full family record →
          </Link>
        </div>
      ) : null}
    </div>
  );
}
