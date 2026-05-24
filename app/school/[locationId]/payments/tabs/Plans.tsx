// Tuition Plans tab — list of family_tuition_enrollments with progress.

import Link from 'next/link';
import { Plus } from 'lucide-react';
import { query } from '@/lib/db';
import { HelpCallout } from '@/components/HelpCallout';

export async function PaymentsHubPlans({
  schoolId, locationId,
}: { schoolId: string; locationId: string }) {
  const { rows: enrollments } = await query<{
    id: string;
    family_label: string;
    student_label: string | null;
    academic_year: string;
    grid_label: string;
    plan_label: string;
    total_annual_cents: number;
    installment_count: number;
    status: string;
    invoices_open: number;
    invoices_paid: number;
    amount_paid_cents: number;
  }>(
    `SELECT e.id,
            COALESCE(NULLIF(f.display_name, ''),
                     CONCAT_WS(' ', p.first_name, p.last_name),
                     '(unnamed)') AS family_label,
            CASE WHEN st.id IS NOT NULL
                 THEN CONCAT_WS(' ', COALESCE(NULLIF(st.preferred_name, ''), st.first_name), st.last_name)
                 ELSE NULL END AS student_label,
            e.academic_year,
            g.display_name AS grid_label,
            pl.display_name AS plan_label,
            e.total_annual_cents,
            e.installment_count,
            e.status,
            (SELECT COUNT(*)::int FROM invoices WHERE source = 'tuition_plan'
              AND source_ref->>'enrollment_id' = e.id::text
              AND status IN ('open', 'partially_paid')) AS invoices_open,
            (SELECT COUNT(*)::int FROM invoices WHERE source = 'tuition_plan'
              AND source_ref->>'enrollment_id' = e.id::text
              AND status = 'paid') AS invoices_paid,
            (SELECT COALESCE(SUM(amount_paid_cents), 0)::int FROM invoices
              WHERE source = 'tuition_plan'
                AND source_ref->>'enrollment_id' = e.id::text) AS amount_paid_cents
       FROM family_tuition_enrollments e
       JOIN families f ON f.id = e.family_id
       JOIN tuition_grids g ON g.id = e.tuition_grid_id
       JOIN payment_plans pl ON pl.id = e.payment_plan_id
       LEFT JOIN students st ON st.id = e.student_id
       LEFT JOIN LATERAL (
         SELECT first_name, last_name FROM parents
          WHERE family_id = f.id AND is_primary = true LIMIT 1
       ) p ON true
      WHERE e.school_id = $1
      ORDER BY e.status, e.academic_year DESC, family_label
      LIMIT 200`,
    [schoolId],
  );

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Tuition plans</h2>
          <p className="text-sm text-slate-500">
            Family enrollments. Each one generates monthly / semi-annual / annual installments automatically.
          </p>
        </div>
        <Link
          href={`/school/${locationId}/enrollments/start`}
          className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
        >
          <Plus className="h-4 w-4" /> Start an enrollment
        </Link>
      </div>

      <HelpCallout
        title="How tuition plans work"
        defaultOpen={false}
        steps={[
          <>A <strong>tuition plan</strong> is one family + one program + one payment schedule (monthly, semi-annual, annual). Starting a plan generates all the installments automatically.</>,
          <>Each green progress bar shows how much of the year&apos;s tuition has been paid. The <strong>3/12</strong>-style counter shows paid installments / total installments.</>,
          <><strong>Click any row</strong> to open the plan detail page. From there you can edit individual installments, split a payment, reschedule the remaining balance across more (or fewer) months, pause / resume, or add a one-off charge.</>,
          <>To start a new plan: click <strong>Start an enrollment</strong>. You&apos;ll pick the family, the program (grid), and the payment plan; invoices get generated for the whole year.</>,
          <>Use the <strong>Status</strong> column to spot stalled plans: paused plans don&apos;t auto-charge; cancelled plans are archived.</>,
        ]}
      />

      <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-100 text-left text-[10px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2.5 font-medium">Family</th>
              <th className="px-4 py-2.5 font-medium">Program · Plan</th>
              <th className="px-4 py-2.5 font-medium">Year</th>
              <th className="px-4 py-2.5 font-medium text-right">Annual</th>
              <th className="px-4 py-2.5 font-medium">Progress</th>
              <th className="px-4 py-2.5 font-medium text-center">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {enrollments.length === 0 ? (
              <tr><td colSpan={6} className="p-10 text-center text-sm text-slate-500 italic">
                No enrollments yet. Click <strong>Start an enrollment</strong> to set up the first family.
              </td></tr>
            ) : enrollments.map((e) => {
              const pct = e.total_annual_cents > 0 ? Math.round((e.amount_paid_cents / e.total_annual_cents) * 100) : 0;
              const planHref = `/school/${locationId}/payments/plans/${e.id}`;
              return (
                <tr key={e.id} className="hover:bg-slate-50 cursor-pointer group">
                  <td className="px-4 py-2">
                    <Link href={planHref} className="block">
                      <div className="text-slate-900 group-hover:text-blue-700">{e.family_label}</div>
                      {e.student_label ? <div className="text-[11px] text-slate-500">{e.student_label}</div> : null}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-xs">
                    <Link href={planHref} className="block">
                      <div className="text-slate-900">{e.grid_label}</div>
                      <div className="text-[11px] text-slate-500">{e.plan_label}</div>
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-xs font-mono">
                    <Link href={planHref} className="block">{e.academic_year}</Link>
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    <Link href={planHref} className="block">${(e.total_annual_cents / 100).toFixed(2)}</Link>
                  </td>
                  <td className="px-4 py-2">
                    <Link href={planHref} className="block">
                      <div className="flex items-center gap-2">
                        <div className="h-2 flex-1 rounded-full bg-slate-100 overflow-hidden min-w-[80px]">
                          <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="text-[10px] text-slate-600 tabular-nums whitespace-nowrap">
                          {e.invoices_paid}/{e.invoices_paid + e.invoices_open}
                        </span>
                      </div>
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-center">
                    <Link href={planHref} className="block"><StatusPill status={e.status} /></Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {void locationId}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { bg: string; fg: string }> = {
    active:    { bg: 'bg-emerald-100', fg: 'text-emerald-800' },
    paused:    { bg: 'bg-amber-100',   fg: 'text-amber-800' },
    completed: { bg: 'bg-blue-100',    fg: 'text-blue-800' },
    cancelled: { bg: 'bg-slate-100',   fg: 'text-slate-600' },
  };
  const cfg = map[status] ?? { bg: 'bg-slate-100', fg: 'text-slate-600' };
  return <span className={`rounded-full ${cfg.bg} px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${cfg.fg}`}>{status}</span>;
}
