// /school/[locationId]/families/[familyId]/statement
//
// Family account statement + payment schedule, mirroring the FACTS print
// views (Institution Balances + Payment Schedule) so DGM can see — for
// every family — assessed / credits / payments / remaining per student per
// account, and the installment timeline. Printable (Print / Save PDF).
//
// Statement figures come from the imported FACTS per-account ledger
// (facts_account_ledger); the schedule comes from the Growth Suite tuition
// invoices.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { query } from '@/lib/db';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { PrintButton } from './PrintButton';

export const dynamic = 'force-dynamic';

type Params = Promise<{ locationId: string; familyId: string }>;
const YEAR = '2026-27';
const TERM = '2026–2027 School Year';

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const moneyOrBlank = (cents: number) => (cents === 0 ? '' : money(cents));

// FACTS-style account ordering.
const ACCT_ORDER = [
  'annual_tuition', 'extended_day', 'organic_lunch', 'administrative_fee',
  'enrollment_fee', 'chromebook_fee', 'withdrawal_fee',
];
const orderIdx = (k: string) => { const i = ACCT_ORDER.indexOf(k); return i === -1 ? 99 : i; };

interface LedgerRow {
  student_id: string; account: string; account_key: string;
  charges_cents: number; credits_cents: number; payments_cents: number; ending_balance_cents: number;
}
interface InvRow { student_id: string; due_at: Date | null; total_cents: number; status: string; }

export default async function FamilyStatementPage({ params }: { params: Params }) {
  const { locationId, familyId } = await params;
  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();

  const famRows = await query<{ display_name: string }>(
    `SELECT display_name FROM families WHERE id = $1 AND school_id = $2`,
    [familyId, school.id],
  );
  if (famRows.rows.length === 0) notFound();
  const familyName = famRows.rows[0].display_name || 'Family';

  const [students, parentRows] = await Promise.all([
    query<{ id: string; first_name: string; last_name: string; preferred_name: string | null }>(
      `SELECT id, first_name, last_name, preferred_name FROM students
        WHERE family_id = $1 AND school_id = $2 ORDER BY last_name, first_name`,
      [familyId, school.id],
    ).then((r) => r.rows),
    query<{ nm: string }>(
      `SELECT first_name || ' ' || last_name AS nm FROM parents
        WHERE family_id = $1 AND is_primary = true AND status = 'active' LIMIT 1`,
      [familyId],
    ).then((r) => r.rows),
  ]);
  const studentName = (s: { first_name: string; last_name: string; preferred_name: string | null }) =>
    `${(s.preferred_name && s.preferred_name.trim()) || s.first_name} ${s.last_name}`;
  const studentIds = students.map((s) => s.id);
  const customerName = parentRows[0]?.nm || familyName;

  const [ledger, invoices] = studentIds.length === 0 ? [[], []] : await Promise.all([
    query<LedgerRow>(
      `SELECT student_id, account, account_key, charges_cents, credits_cents, payments_cents, ending_balance_cents
         FROM facts_account_ledger
        WHERE school_id = $1 AND academic_year = $2 AND student_id = ANY($3::uuid[])`,
      [school.id, YEAR, studentIds],
    ).then((r) => r.rows),
    query<InvRow>(
      `SELECT student_id, due_at, total_cents, status
         FROM invoices
        WHERE school_id = $1 AND source = 'tuition_plan' AND voided_at IS NULL AND student_id = ANY($2::uuid[])
        ORDER BY due_at`,
      [school.id, studentIds],
    ).then((r) => r.rows),
  ]);

  // Group statement rows by student.
  const byStudent = new Map<string, LedgerRow[]>();
  for (const r of ledger) {
    const arr = byStudent.get(r.student_id) ?? [];
    arr.push(r); byStudent.set(r.student_id, arr);
  }
  const fam = { a: 0, cr: 0, p: 0, r: 0 };
  for (const r of ledger) { fam.a += r.charges_cents; fam.cr += r.credits_cents; fam.p += r.payments_cents; fam.r += r.ending_balance_cents; }

  // Build payment schedule: due date → per-student amount.
  const dateKey = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '—');
  const schedStudents = students.filter((s) => invoices.some((i) => i.student_id === s.id));
  const byDate = new Map<string, Map<string, number>>();
  for (const i of invoices) {
    const k = dateKey(i.due_at);
    const m = byDate.get(k) ?? new Map<string, number>();
    m.set(i.student_id, (m.get(i.student_id) ?? 0) + i.total_cents);
    byDate.set(k, m);
  }
  const scheduleDates = [...byDate.keys()].sort();
  const anyDraft = invoices.some((i) => i.status === 'draft');

  const backHref = `/school/${locationId}/finance?fintab=students`;

  return (
    <main className="flex flex-1 flex-col items-center bg-slate-100 p-6 min-h-screen print:bg-white print:p-0">
      <div className="w-full max-w-4xl space-y-3">
        <div className="flex items-center justify-between gap-2 print:hidden">
          <Link href={backHref} className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700">
            <ArrowLeft className="h-3 w-3" /> Back to Finance Hub
          </Link>
          <PrintButton />
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm print:border-0 print:shadow-none">
          {/* Letterhead */}
          <div className="flex items-start justify-between gap-4 border-b border-slate-200 pb-4">
            <div>
              <div className="text-lg font-bold text-slate-900">{school.name}</div>
              <div className="text-xs text-slate-500">Account statement · {TERM}</div>
            </div>
            <div className="text-right text-xs text-slate-600">
              <div className="font-medium text-slate-900">{customerName}</div>
              <div>{familyName}</div>
            </div>
          </div>
          <div className="flex flex-wrap gap-x-8 gap-y-1 pt-3 text-xs text-slate-600">
            <span>Students: <strong className="text-slate-800">{students.map(studentName).join(', ') || '—'}</strong></span>
          </div>

          {/* Statement (Institution Balances) */}
          <h2 className="mt-5 mb-2 text-sm font-semibold text-slate-900">Account balances</h2>
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="py-1.5 text-left font-medium">Student / account</th>
                <th className="py-1.5 text-right font-medium">Assessed</th>
                <th className="py-1.5 text-right font-medium">Credits</th>
                <th className="py-1.5 text-right font-medium">Payments</th>
                <th className="py-1.5 text-right font-medium">Remaining</th>
              </tr>
            </thead>
            {students.map((s) => {
              const rows = (byStudent.get(s.id) ?? []).slice().sort((a, b) => orderIdx(a.account_key) - orderIdx(b.account_key));
              const sub = rows.reduce((acc, r) => {
                acc.a += r.charges_cents; acc.cr += r.credits_cents; acc.p += r.payments_cents; acc.r += r.ending_balance_cents; return acc;
              }, { a: 0, cr: 0, p: 0, r: 0 });
              return (
                <tbody key={s.id}>
                  <tr className="border-t border-slate-100 bg-slate-50">
                    <td className="py-1.5 pl-1 font-semibold text-slate-900">{studentName(s)}</td>
                    <td className="py-1.5 text-right tabular-nums font-semibold">{money(sub.a)}</td>
                    <td className="py-1.5 text-right tabular-nums font-semibold text-emerald-700">{moneyOrBlank(sub.cr)}</td>
                    <td className="py-1.5 text-right tabular-nums font-semibold text-emerald-700">{moneyOrBlank(sub.p)}</td>
                    <td className="py-1.5 text-right tabular-nums font-semibold text-slate-900">{money(sub.r)}</td>
                  </tr>
                  {rows.length === 0 ? (
                    <tr><td colSpan={5} className="py-1.5 pl-5 text-xs italic text-slate-400">No FACTS charges on record</td></tr>
                  ) : rows.map((r) => (
                    <tr key={r.account_key} className="text-slate-700">
                      <td className="py-1 pl-5 text-[13px]">{r.account}{r.credits_cents > 0 ? <span className="text-[11px] text-emerald-700"> · incl. discount</span> : null}</td>
                      <td className="py-1 text-right tabular-nums text-[13px]">{moneyOrBlank(r.charges_cents)}</td>
                      <td className="py-1 text-right tabular-nums text-[13px] text-emerald-700">{moneyOrBlank(r.credits_cents)}</td>
                      <td className="py-1 text-right tabular-nums text-[13px] text-emerald-700">{moneyOrBlank(r.payments_cents)}</td>
                      <td className="py-1 text-right tabular-nums text-[13px]">{money(r.ending_balance_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              );
            })}
            <tbody>
              <tr className="border-t-2 border-slate-300 text-sm font-bold text-slate-900">
                <td className="py-2 pl-1">Family total</td>
                <td className="py-2 text-right tabular-nums">{money(fam.a)}</td>
                <td className="py-2 text-right tabular-nums text-emerald-700">{moneyOrBlank(fam.cr)}</td>
                <td className="py-2 text-right tabular-nums text-emerald-700">{moneyOrBlank(fam.p)}</td>
                <td className="py-2 text-right tabular-nums">{money(fam.r)}</td>
              </tr>
            </tbody>
          </table>
          <p className="mt-1.5 text-[11px] text-slate-500">
            Assessed = total charged · Credits = discounts applied · Payments = collected in FACTS to date · Remaining = balance carried into Growth Suite billing.
          </p>

          {/* Payment schedule */}
          <h2 className="mt-6 mb-2 text-sm font-semibold text-slate-900">Payment schedule</h2>
          {scheduleDates.length === 0 ? (
            <p className="text-sm text-slate-500">No payment schedule set up yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 text-[11px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-1.5 text-left font-medium">Due date</th>
                  {schedStudents.map((s) => (
                    <th key={s.id} className="py-1.5 text-right font-medium">{studentName(s)}</th>
                  ))}
                  <th className="py-1.5 text-right font-medium">Payment</th>
                </tr>
              </thead>
              <tbody>
                {scheduleDates.map((d) => {
                  const m = byDate.get(d)!;
                  const total = [...m.values()].reduce((a, b) => a + b, 0);
                  return (
                    <tr key={d} className="border-t border-slate-100 text-slate-700">
                      <td className="py-1.5 tabular-nums">{d}</td>
                      {schedStudents.map((s) => (
                        <td key={s.id} className="py-1.5 text-right tabular-nums text-[13px]">{m.has(s.id) ? money(m.get(s.id)!) : '—'}</td>
                      ))}
                      <td className="py-1.5 text-right tabular-nums font-semibold text-slate-900">{money(total)}</td>
                    </tr>
                  );
                })}
                <tr className="border-t-2 border-slate-300 text-sm font-bold text-slate-900">
                  <td className="py-2">Total scheduled</td>
                  {schedStudents.map((s) => {
                    const t = invoices.filter((i) => i.student_id === s.id).reduce((a, b) => a + b.total_cents, 0);
                    return <td key={s.id} className="py-2 text-right tabular-nums">{money(t)}</td>;
                  })}
                  <td className="py-2 text-right tabular-nums">{money(invoices.reduce((a, b) => a + b.total_cents, 0))}</td>
                </tr>
              </tbody>
            </table>
          )}
          {anyDraft ? (
            <p className="mt-1.5 text-[11px] text-amber-700">
              Scheduled payments are drafts while billing is in test mode — autopay drafts begin once the school goes live.
            </p>
          ) : null}

          <div className="mt-5 border-t border-slate-200 pt-2 text-[10px] text-slate-400">
            Generated by Growth Suite · {school.name} · {TERM}
          </div>
        </div>
      </div>
    </main>
  );
}
