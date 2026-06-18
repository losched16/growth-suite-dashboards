'use client';

// Payment-schedule table with expandable rows: click a due date to see the
// fee breakdown that makes up that payment (per student, per account) —
// mirroring the FACTS payment schedule. Detail rows are hidden on screen
// until expanded, but always shown when printing so the printed statement
// carries the full breakdown.

import { useState, Fragment } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';

const money = (c: number) =>
  `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export interface SchedLine { description: string; amount: number }
export interface SchedStudent { id: string; name: string; total: number; lines: SchedLine[] }
export interface SchedRow { date: string; students: SchedStudent[]; total: number }

export function PaymentSchedule({
  rows, columns, totals, grandTotal,
}: {
  rows: SchedRow[];
  columns: Array<{ id: string; name: string }>;
  totals: Record<string, number>;
  grandTotal: number;
}) {
  // Open the first row by default so the breakdown is visible immediately.
  // Every payment's account breakdown is shown by default (matches the
  // FACTS schedule); a date can be clicked to collapse it to just totals.
  const [open, setOpen] = useState<Set<string>>(() => new Set(rows.map((r) => r.date)));
  const toggle = (date: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(date)) next.delete(date); else next.add(date);
    return next;
  });

  return (
    <table className="w-full text-sm">
      <thead className="border-b border-slate-200 text-[11px] uppercase tracking-wide text-slate-500">
        <tr>
          <th className="py-1.5 text-left font-medium">Due date</th>
          {columns.map((c) => <th key={c.id} className="py-1.5 text-right font-medium">{c.name}</th>)}
          <th className="py-1.5 text-right font-medium">Payment</th>
        </tr>
      </thead>
      {rows.map((r) => {
        const isOpen = open.has(r.date);
        return (
          <tbody key={r.date}>
            <tr className="cursor-pointer border-t border-slate-100 text-slate-700 hover:bg-slate-50" onClick={() => toggle(r.date)}>
              <td className="py-1.5 tabular-nums">
                <span className="mr-1 inline-block align-middle text-slate-400 print:hidden">
                  {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                </span>
                {r.date}
              </td>
              {columns.map((c) => {
                const s = r.students.find((x) => x.id === c.id);
                return <td key={c.id} className="py-1.5 text-right tabular-nums text-[13px]">{s ? money(s.total) : '—'}</td>;
              })}
              <td className="py-1.5 text-right tabular-nums font-semibold text-slate-900">{money(r.total)}</td>
            </tr>
            <tr className={isOpen ? '' : 'hidden print:table-row'}>
              <td colSpan={columns.length + 2} className="bg-slate-50/70 px-3 py-2 print:bg-transparent">
                <div className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
                  {r.students.map((s) => (
                    <div key={s.id}>
                      <div className="mb-0.5 text-[12px] font-semibold text-slate-800">{s.name} · {money(s.total)}</div>
                      <table className="w-full text-[12px]">
                        <tbody>
                          {s.lines.map((l, i) => (
                            <tr key={i} className="text-slate-600">
                              <td className="py-0.5">{l.description}</td>
                              <td className={`py-0.5 text-right tabular-nums ${l.amount < 0 ? 'text-emerald-700' : ''}`}>
                                {l.amount < 0 ? '−' : ''}{money(Math.abs(l.amount))}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
              </td>
            </tr>
          </tbody>
        );
      })}
      <tbody>
        <tr className="border-t-2 border-slate-300 text-sm font-bold text-slate-900">
          <td className="py-2">Total scheduled</td>
          {columns.map((c) => <td key={c.id} className="py-2 text-right tabular-nums">{money(totals[c.id] ?? 0)}</td>)}
          <td className="py-2 text-right tabular-nums">{money(grandTotal)}</td>
        </tr>
      </tbody>
    </table>
  );
}
