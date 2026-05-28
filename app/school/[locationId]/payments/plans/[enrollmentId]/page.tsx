// /school/[locationId]/payments/plans/[enrollmentId] — modify a
// family's tuition plan. Reachable by clicking a row in the Plans tab
// or a family link on an invoice / submission row.
//
// The page is server-rendered. Inline edit / split forms are URL-
// state-driven (?edit=invoiceId / ?split=invoiceId / ?reschedule=1) so
// the entire UI stays in RSC — no client-side state machine needed.
//
// Supported plan operations (one POST handler dispatches all of them):
//   pause                — flip enrollment status to 'paused'
//   resume               — flip enrollment status back to 'active'
//   edit_installment     — change due_at + total_cents on a single open invoice
//   split_installment    — void original, create two new invoices for same enrollment
//   reschedule_remaining — sum open balance, void open invoices, regenerate N new
//                          installments starting from a chosen date

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Pause, Play, Edit3, Scissors, Calendar, Plus, RotateCw } from 'lucide-react';
import { query } from '@/lib/db';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { HelpCallout } from '@/components/HelpCallout';
import { BillingSplitEditor } from './BillingSplitEditor';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type Params = Promise<{ locationId: string; enrollmentId: string }>;
type SearchParams = Promise<{
  msg?: string; err?: string;
  edit?: string; split?: string; reschedule?: string;
}>;

interface EnrollmentRow {
  id: string;
  school_id: string;
  family_id: string;
  student_id: string | null;
  academic_year: string;
  status: 'active' | 'paused' | 'completed' | 'cancelled';
  total_annual_cents: number;
  installment_count: number;
  internal_note: string | null;
  family_label: string;
  student_label: string | null;
  grid_label: string;
  plan_label: string;
}

interface InvoiceRow {
  id: string;
  invoice_number: string;
  installment_number: number | null;
  status: string;
  total_cents: number;
  amount_paid_cents: number;
  // node-postgres returns `date`/`timestamptz` columns as JS Date objects,
  // NOT strings — so the runtime type is wider than the TS hint. Use
  // toIso() below before slicing.
  due_at: string | Date;
  voided_at: string | Date | null;
  voided_reason: string | null;
  title: string;
}

// Coerce a value that node-postgres returned for a date/timestamptz
// column into an ISO string. Handles Date, string, and null.
function toIso(v: string | Date | null | undefined): string {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

export default async function PlanDetailPage({
  params, searchParams,
}: { params: Params; searchParams: SearchParams }) {
  const { locationId, enrollmentId } = await params;
  const sp = await searchParams;

  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();
  const schoolId = school.id;

  const { rows: eRows } = await query<EnrollmentRow>(
    `SELECT e.id, e.school_id, e.family_id, e.student_id, e.academic_year, e.status,
            e.total_annual_cents, e.installment_count, e.internal_note,
            COALESCE(NULLIF(f.display_name, ''),
                     CONCAT_WS(' ', p.first_name, p.last_name),
                     '(unnamed family)') AS family_label,
            CASE WHEN st.id IS NOT NULL
                 THEN CONCAT_WS(' ', COALESCE(NULLIF(st.preferred_name, ''), st.first_name), st.last_name)
                 ELSE NULL END AS student_label,
            g.display_name AS grid_label,
            pl.display_name AS plan_label
       FROM family_tuition_enrollments e
       JOIN families f ON f.id = e.family_id
       JOIN tuition_grids g ON g.id = e.tuition_grid_id
       JOIN payment_plans pl ON pl.id = e.payment_plan_id
       LEFT JOIN students st ON st.id = e.student_id
       LEFT JOIN LATERAL (
         SELECT first_name, last_name FROM parents
         WHERE family_id = e.family_id AND is_primary = true LIMIT 1
       ) p ON true
      WHERE e.id = $1 AND e.school_id = $2`,
    [enrollmentId, schoolId],
  );
  const enr = eRows[0];
  if (!enr) notFound();

  // Pull all invoices for this enrollment, paid + open + voided. Sort by
  // due_at so the timeline reads top-down. installment_number is in the
  // source_ref jsonb on the invoice row.
  const { rows: invs } = await query<InvoiceRow>(
    `SELECT i.id, i.invoice_number,
            (i.source_ref->>'installment_number')::int AS installment_number,
            i.status, i.total_cents, i.amount_paid_cents,
            i.due_at, i.voided_at, i.voided_reason, i.title
       FROM invoices i
      WHERE i.source = 'tuition_plan'
        AND i.source_ref->>'enrollment_id' = $1
        AND i.school_id = $2
      ORDER BY i.due_at ASC, i.created_at ASC`,
    [enrollmentId, schoolId],
  );

  const paidTotal = invs.reduce((s, i) => s + i.amount_paid_cents, 0);
  const liveInvoices = invs.filter((i) => i.status !== 'voided');
  const expectedTotal = liveInvoices.reduce((s, i) => s + i.total_cents, 0);
  const balance = expectedTotal - paidTotal;
  const todayIso = new Date().toISOString().slice(0, 10);

  const backHref = `/school/${locationId}/payments?tab=plans`;
  const selfHref = `/school/${locationId}/payments/plans/${enrollmentId}`;
  // Posted to every action API so it redirects back here.
  const returnTo = selfHref;

  // Parents on the family + any existing billing-share rows. Joined so
  // the BillingSplitEditor gets the existing share (or 0 if joint).
  const { rows: parentRows } = await query<{
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    is_primary: boolean;
    existing_share_bp: number;
  }>(
    `SELECT p.id, p.first_name, p.last_name, p.email, p.is_primary,
            COALESCE(s.share_basis_points, 0) AS existing_share_bp
       FROM parents p
       LEFT JOIN enrollment_billing_shares s
              ON s.enrollment_id = $1 AND s.parent_id = p.id
      WHERE p.family_id = $2 AND p.school_id = $3 AND p.status = 'active'
      ORDER BY p.is_primary DESC, p.created_at ASC`,
    [enrollmentId, enr.family_id, schoolId],
  );
  const isCurrentlySplit = parentRows.some((p) => p.existing_share_bp > 0);

  return (
    <main className="flex flex-1 flex-col items-center bg-slate-50 p-6 min-h-screen">
      <div className="w-full max-w-5xl space-y-4">
        <Link href={backHref} className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700">
          <ArrowLeft className="h-3 w-3" /> Back to Tuition Plans
        </Link>

        {sp.msg ? (
          <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{sp.msg}</div>
        ) : null}
        {sp.err ? (
          <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{sp.err}</div>
        ) : null}

        {/* HEADER */}
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h1 className="text-2xl font-semibold text-slate-900">{enr.family_label}</h1>
              <p className="text-sm text-slate-600 mt-0.5">
                {enr.student_label ? `${enr.student_label} · ` : ''}
                {enr.grid_label} · {enr.plan_label} · {enr.academic_year}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <StatusPill status={enr.status} />
                {enr.internal_note ? (
                  <span className="text-xs text-slate-500 italic">Note: {enr.internal_note}</span>
                ) : null}
              </div>
            </div>
            <div className="text-right">
              <div className="grid grid-cols-3 gap-3 text-right">
                <Money label="Total"   cents={enr.total_annual_cents} />
                <Money label="Paid"    cents={paidTotal} accent="emerald" />
                <Money label="Balance" cents={balance}   accent={balance === 0 ? 'emerald' : 'amber'} />
              </div>
            </div>
          </div>
        </div>

        <HelpCallout
          title="What you can change on a tuition plan"
          steps={[
            <>Click <strong>Edit</strong> on an upcoming installment to change its due date or amount.</>,
            <>Click <strong>Split</strong> to break one installment into two on different dates (e.g. $500 due 3/1 → $250 due 3/15 + $250 due 3/30).</>,
            <>Use <strong>Reschedule remaining balance</strong> below to spread the unpaid balance across more (or fewer) months — useful for hardship plans.</>,
            <>Use <strong>Pause plan</strong> to halt the rhythm of future autopay reminders. The invoices stay live; you re-activate when ready.</>,
            <>Use <strong>Add charge / credit</strong> for a one-off adjustment (late fee, refund, manual line item).</>,
            <>Set up <strong>split billing</strong> below for divorced / separated families — each parent gets their own invoice and autopay.</>,
          ]}
        />

        {/* Billing-split editor — set per-parent shares for divorced /
            separated families. Only future invoice generation honors
            the change; existing draft/open invoices are not retroactively
            split. */}
        <BillingSplitEditor
          enrollmentId={enrollmentId}
          returnTo={returnTo}
          parents={parentRows}
          isCurrentlySplit={isCurrentlySplit}
        />

        {/* PLAN-LEVEL ACTIONS */}
        <div className="rounded-xl border border-slate-200 bg-white p-4 flex flex-wrap items-center gap-2">
          {enr.status === 'active' ? (
            <form action={`/api/admin/schools/${schoolId}/tuition-plans/${enrollmentId}/action`} method="POST">
              <input type="hidden" name="action" value="pause" />
              <input type="hidden" name="return_to" value={returnTo} />
              <button type="submit" className="inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-800 hover:bg-amber-100">
                <Pause className="h-3.5 w-3.5" /> Pause plan
              </button>
            </form>
          ) : enr.status === 'paused' ? (
            <form action={`/api/admin/schools/${schoolId}/tuition-plans/${enrollmentId}/action`} method="POST">
              <input type="hidden" name="action" value="resume" />
              <input type="hidden" name="return_to" value={returnTo} />
              <button type="submit" className="inline-flex items-center gap-1.5 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-800 hover:bg-emerald-100">
                <Play className="h-3.5 w-3.5" /> Resume plan
              </button>
            </form>
          ) : null}

          <Link
            href={`/school/${locationId}/payments/invoices/new?family=${enr.family_id}`}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <Plus className="h-3.5 w-3.5" /> Add one-off charge / credit
          </Link>

          {!sp.reschedule ? (
            <Link
              href={`${selfHref}?reschedule=1`}
              className="inline-flex items-center gap-1.5 rounded-md border border-blue-300 bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-800 hover:bg-blue-100"
            >
              <RotateCw className="h-3.5 w-3.5" /> Reschedule remaining balance
            </Link>
          ) : null}
        </div>

        {/* RESCHEDULE REMAINING BALANCE — collapsible */}
        {sp.reschedule ? (
          <form
            action={`/api/admin/schools/${schoolId}/tuition-plans/${enrollmentId}/action`}
            method="POST"
            className="rounded-xl border-2 border-blue-300 bg-blue-50/30 p-5 space-y-3"
          >
            <input type="hidden" name="action" value="reschedule_remaining" />
            <input type="hidden" name="return_to" value={returnTo} />

            <div>
              <h2 className="text-base font-semibold text-blue-900">Reschedule remaining balance</h2>
              <p className="text-xs text-blue-800 mt-0.5">
                Voids all currently-open (unpaid) installments and replaces them with{' '}
                <strong>N new monthly installments</strong> starting on the chosen date.
                Paid + partially-paid invoices are <strong>preserved as-is</strong>.
              </p>
              <p className="text-xs text-blue-700 mt-1">
                Outstanding balance: <strong>${(balance / 100).toFixed(2)}</strong> across{' '}
                {invs.filter((i) => i.status === 'open' || i.status === 'draft').length} unpaid installment(s).
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <label className="block text-sm">
                <span className="text-[11px] font-medium uppercase tracking-wide text-slate-700">Number of new installments</span>
                <input type="number" name="new_count" min="1" max="36" defaultValue="10" required className={inputCls} />
              </label>
              <label className="block text-sm">
                <span className="text-[11px] font-medium uppercase tracking-wide text-slate-700">Start date (first new due date)</span>
                <input type="date" name="start_date" defaultValue={todayIso} required className={inputCls} />
              </label>
              <label className="block text-sm">
                <span className="text-[11px] font-medium uppercase tracking-wide text-slate-700">Cadence</span>
                <select name="cadence" className={inputCls}>
                  <option value="monthly">Monthly (same day each month)</option>
                  <option value="biweekly">Every 2 weeks</option>
                  <option value="weekly">Weekly</option>
                </select>
              </label>
            </div>

            <div className="flex gap-2 pt-2 border-t border-blue-200">
              <button type="submit" className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
                Apply reschedule
              </button>
              <Link href={selfHref} className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">
                Cancel
              </Link>
            </div>
          </form>
        ) : null}

        {/* INSTALLMENTS TABLE */}
        <section className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="border-b border-slate-100 px-4 py-2.5 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">
              Installments ({invs.length})
            </h2>
            <span className="text-xs text-slate-500">
              {invs.filter((i) => i.status === 'paid').length} paid ·{' '}
              {invs.filter((i) => i.status === 'open' || i.status === 'draft' || i.status === 'partially_paid').length} open ·{' '}
              {invs.filter((i) => i.status === 'voided').length} voided
            </span>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-100 text-left text-[10px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">#</th>
                <th className="px-4 py-2 font-medium">Invoice</th>
                <th className="px-4 py-2 font-medium">Due</th>
                <th className="px-4 py-2 font-medium text-right">Amount</th>
                <th className="px-4 py-2 font-medium text-right">Paid</th>
                <th className="px-4 py-2 font-medium text-center">Status</th>
                <th className="px-4 py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {invs.length === 0 ? (
                <tr><td colSpan={7} className="p-8 text-center text-sm text-slate-500 italic">
                  No installments yet. (Plan was created but no invoices generated — contact support.)
                </td></tr>
              ) : invs.map((i) => {
                const editing = sp.edit === i.id;
                const splitting = sp.split === i.id;
                const isEditable = i.status === 'open' || i.status === 'draft';
                return (
                  <RowOrForm
                    key={i.id}
                    inv={i}
                    editing={editing}
                    splitting={splitting}
                    isEditable={isEditable}
                    schoolId={schoolId}
                    locationId={locationId}
                    enrollmentId={enrollmentId}
                    returnTo={returnTo}
                    selfHref={selfHref}
                  />
                );
              })}
            </tbody>
          </table>
        </section>
      </div>
    </main>
  );
}

function RowOrForm({
  inv, editing, splitting, isEditable, schoolId, locationId, enrollmentId, returnTo, selfHref,
}: {
  inv: InvoiceRow;
  editing: boolean;
  splitting: boolean;
  isEditable: boolean;
  schoolId: string;
  locationId: string;
  enrollmentId: string;
  returnTo: string;
  selfHref: string;
}) {
  const dueIso = toIso(inv.due_at).slice(0, 10);
  const amountDollars = (inv.total_cents / 100).toFixed(2);

  if (editing) {
    return (
      <tr className="bg-blue-50/40">
        <td colSpan={7} className="px-4 py-3">
          <form action={`/api/admin/schools/${schoolId}/tuition-plans/${enrollmentId}/action`} method="POST" className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="action" value="edit_installment" />
            <input type="hidden" name="invoice_id" value={inv.id} />
            <input type="hidden" name="return_to" value={returnTo} />
            <div className="text-xs text-slate-600">
              Editing <span className="font-mono">{inv.invoice_number}</span>
              {inv.installment_number ? ` (installment #${inv.installment_number})` : ''}
            </div>
            <label className="block">
              <span className="block text-[10px] font-medium uppercase tracking-wide text-slate-600">Due date</span>
              <input type="date" name="due_date" defaultValue={dueIso} required className={inputCls} />
            </label>
            <label className="block">
              <span className="block text-[10px] font-medium uppercase tracking-wide text-slate-600">Amount ($)</span>
              <input type="number" step="0.01" min="0" name="amount" defaultValue={amountDollars} required className={inputCls} />
            </label>
            <button type="submit" className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700">
              Save changes
            </button>
            <Link href={selfHref} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
              Cancel
            </Link>
          </form>
        </td>
      </tr>
    );
  }

  if (splitting) {
    const halfDollars = (Math.floor(inv.total_cents / 2) / 100).toFixed(2);
    const remainderDollars = ((inv.total_cents - Math.floor(inv.total_cents / 2)) / 100).toFixed(2);
    // Default the 2nd half to 15 days after the first.
    const second = new Date(toIso(inv.due_at));
    second.setDate(second.getDate() + 15);
    const secondIso = second.toISOString().slice(0, 10);
    return (
      <tr className="bg-violet-50/40">
        <td colSpan={7} className="px-4 py-3">
          <form action={`/api/admin/schools/${schoolId}/tuition-plans/${enrollmentId}/action`} method="POST" className="space-y-2">
            <input type="hidden" name="action" value="split_installment" />
            <input type="hidden" name="invoice_id" value={inv.id} />
            <input type="hidden" name="return_to" value={returnTo} />
            <div className="text-xs text-slate-700">
              Splitting <span className="font-mono">{inv.invoice_number}</span> (${amountDollars}). The
              original invoice will be <strong>voided</strong> and replaced by these two:
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="rounded border border-violet-200 bg-white p-2">
                <div className="text-[11px] uppercase tracking-wide text-violet-800 mb-1">First half</div>
                <label className="block mb-1">
                  <span className="block text-[10px] font-medium uppercase tracking-wide text-slate-600">Due date</span>
                  <input type="date" name="first_due" defaultValue={dueIso} required className={inputCls} />
                </label>
                <label className="block">
                  <span className="block text-[10px] font-medium uppercase tracking-wide text-slate-600">Amount ($)</span>
                  <input type="number" step="0.01" min="0" name="first_amount" defaultValue={halfDollars} required className={inputCls} />
                </label>
              </div>
              <div className="rounded border border-violet-200 bg-white p-2">
                <div className="text-[11px] uppercase tracking-wide text-violet-800 mb-1">Second half</div>
                <label className="block mb-1">
                  <span className="block text-[10px] font-medium uppercase tracking-wide text-slate-600">Due date</span>
                  <input type="date" name="second_due" defaultValue={secondIso} required className={inputCls} />
                </label>
                <label className="block">
                  <span className="block text-[10px] font-medium uppercase tracking-wide text-slate-600">Amount ($)</span>
                  <input type="number" step="0.01" min="0" name="second_amount" defaultValue={remainderDollars} required className={inputCls} />
                </label>
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <button type="submit" className="rounded-md bg-violet-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-violet-700">
                Apply split
              </button>
              <Link href={selfHref} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
                Cancel
              </Link>
            </div>
          </form>
        </td>
      </tr>
    );
  }

  return (
    <tr className={inv.status === 'voided' ? 'text-slate-400' : ''}>
      <td className="px-4 py-2 tabular-nums text-xs">{inv.installment_number ?? '—'}</td>
      <td className="px-4 py-2">
        <Link href={`/school/${locationId}/payments/invoices/${inv.id}`} className="font-mono text-xs text-blue-600 hover:underline">
          {inv.invoice_number}
        </Link>
      </td>
      <td className="px-4 py-2 text-xs text-slate-600">
        {new Date(toIso(inv.due_at)).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
      </td>
      <td className="px-4 py-2 text-right font-mono text-sm">${(inv.total_cents / 100).toFixed(2)}</td>
      <td className="px-4 py-2 text-right font-mono text-xs text-emerald-700">
        {inv.amount_paid_cents > 0 ? `$${(inv.amount_paid_cents / 100).toFixed(2)}` : '—'}
      </td>
      <td className="px-4 py-2 text-center">
        <InvStatusPill status={inv.status} />
      </td>
      <td className="px-4 py-2 text-right whitespace-nowrap">
        {isEditable ? (
          <div className="inline-flex items-center gap-1">
            <Link
              href={`${selfHref}?edit=${inv.id}`}
              className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
            >
              <Edit3 className="h-3 w-3" /> Edit
            </Link>
            <Link
              href={`${selfHref}?split=${inv.id}`}
              className="inline-flex items-center gap-1 rounded border border-violet-300 bg-white px-2 py-1 text-[11px] font-medium text-violet-700 hover:bg-violet-50"
            >
              <Scissors className="h-3 w-3" /> Split
            </Link>
          </div>
        ) : inv.status === 'voided' ? (
          <span className="text-[10px] italic text-slate-400" title={inv.voided_reason ?? ''}>voided</span>
        ) : (
          <Link href={`/school/${locationId}/payments/invoices/${inv.id}`} className="text-[11px] text-slate-500 hover:text-slate-700 underline">
            view
          </Link>
        )}
      </td>
    </tr>
  );
}

function StatusPill({ status }: { status: EnrollmentRow['status'] }) {
  const cfg = status === 'active'    ? { bg: 'bg-emerald-100', fg: 'text-emerald-800', label: 'Active' }
            : status === 'paused'    ? { bg: 'bg-amber-100',   fg: 'text-amber-800',   label: 'Paused' }
            : status === 'completed' ? { bg: 'bg-blue-100',    fg: 'text-blue-800',    label: 'Completed' }
            :                          { bg: 'bg-slate-100',   fg: 'text-slate-600',   label: 'Cancelled' };
  return (
    <span className={`rounded-full ${cfg.bg} px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${cfg.fg}`}>
      {cfg.label}
    </span>
  );
}

function InvStatusPill({ status }: { status: string }) {
  const cfg = status === 'paid'             ? { bg: 'bg-emerald-100', fg: 'text-emerald-800', label: 'Paid' }
            : status === 'partially_paid'   ? { bg: 'bg-amber-100',   fg: 'text-amber-800',   label: 'Partial' }
            : status === 'open'             ? { bg: 'bg-blue-100',    fg: 'text-blue-800',    label: 'Open' }
            : status === 'draft'            ? { bg: 'bg-slate-100',   fg: 'text-slate-700',   label: 'Draft' }
            : status === 'voided'           ? { bg: 'bg-slate-100',   fg: 'text-slate-500',   label: 'Voided' }
            :                                  { bg: 'bg-slate-100',   fg: 'text-slate-600',   label: status };
  return (
    <span className={`rounded-full ${cfg.bg} px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${cfg.fg}`}>
      {cfg.label}
    </span>
  );
}

function Money({ label, cents, accent }: { label: string; cents: number; accent?: 'emerald' | 'amber' }) {
  const fg = accent === 'emerald' ? 'text-emerald-700'
           : accent === 'amber'   ? 'text-amber-700'
           :                        'text-slate-900';
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`font-mono text-sm font-semibold ${fg}`}>${(cents / 100).toFixed(2)}</div>
    </div>
  );
}

const inputCls =
  'mt-0.5 block w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm focus:border-blue-500 focus:outline-none';
