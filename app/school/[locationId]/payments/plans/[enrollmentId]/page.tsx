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
import { ArrowLeft, Pause, Play, Edit3, Scissors, Calendar, Plus, RotateCw, SlidersHorizontal, Banknote, Coins } from 'lucide-react';
import { query } from '@/lib/db';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { HelpCallout } from '@/components/HelpCallout';
import { BillingSplitEditor } from './BillingSplitEditor';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type Params = Promise<{ locationId: string; enrollmentId: string }>;
type SearchParams = Promise<{
  msg?: string; err?: string;
  edit?: string; split?: string; reschedule?: string; changeplan?: string; record?: string; editfees?: string;
}>;

interface EnrollmentRow {
  id: string;
  school_id: string;
  family_id: string;
  student_id: string | null;
  academic_year: string;
  status: 'active' | 'paused' | 'completed' | 'cancelled';
  tuition_grid_id: string;
  payment_plan_id: string;
  total_annual_cents: number;
  installment_count: number;
  internal_note: string | null;
  addons: Array<{ key: string; label: string; amount_cents: number }> | null;
  base_tuition_cents: number;
  family_label: string;
  student_label: string | null;
  grid_label: string;
  plan_label: string;
  // Tuition override (migration 050). NULL = no override (default).
  // 0 = scholarship. >0 = explicit total set by school staff.
  tuition_override_cents: number | null;
  tuition_override_reason: string | null;
  tuition_override_set_by_email: string | null;
  tuition_override_set_at: string | Date | null;
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

interface FeeLine {
  id: string;
  position: number;
  description: string;
  amount_cents: number;
  category: string | null;
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
            e.tuition_grid_id, e.payment_plan_id,
            e.total_annual_cents, e.installment_count, e.internal_note,
            e.addons, g.annual_tuition_cents AS base_tuition_cents,
            e.tuition_override_cents, e.tuition_override_reason,
            e.tuition_override_set_by_email, e.tuition_override_set_at,
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

  // Active tuition grids + payment plans for the "Change plan" editor.
  const { rows: gridOpts } = await query<{ id: string; display_name: string; annual_tuition_cents: number; grade_level: string }>(
    `SELECT id, display_name, annual_tuition_cents, grade_level
       FROM tuition_grids
      WHERE school_id = $1 AND is_active = true
      ORDER BY grade_level, annual_tuition_cents`,
    [schoolId],
  );
  const { rows: planOpts } = await query<{ id: string; display_name: string }>(
    `SELECT id, display_name FROM payment_plans
      WHERE school_id = $1 AND is_active = true
      ORDER BY installment_count`,
    [schoolId],
  );
  // Group grids by grade for an <optgroup>-friendly select.
  const gridsByGrade = gridOpts.reduce<Record<string, typeof gridOpts>>((acc, g) => {
    (acc[g.grade_level] ??= []).push(g);
    return acc;
  }, {});

  // ── Editable fee/credit lines for the "Edit tuition fees" editor ──────
  // The school edits fixed-dollar fees (extended care, deposit, dev fee,
  // scholarship); percentage discounts recompute automatically on save.
  // Editable keys = the school's carry-over keys (fall back to the
  // enrollment's own non-discount addons if no rules are configured).
  const { rows: dcfg } = await query<{ discount_rules: { carry_over_keys?: string[] } | null }>(
    `SELECT discount_rules FROM school_payment_config WHERE school_id = $1`,
    [schoolId],
  );
  const CREDIT_KEYS = new Set(['deposit', 'scholarship']);
  const FEE_LABELS: Record<string, string> = {
    extended_care: 'Extended care', deposit: 'Deposit (paid)',
    development_fee: 'Development fee', scholarship: 'Scholarship',
  };
  const humanizeKey = (k: string) => k.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  const addonList = Array.isArray(enr.addons) ? enr.addons : [];
  const addonByKey = new Map(addonList.map((a) => [a.key, a]));
  const feeKeys = dcfg[0]?.discount_rules?.carry_over_keys?.length
    ? dcfg[0]!.discount_rules!.carry_over_keys!
    : addonList.filter((a) => !/discount/.test(a.key)).map((a) => a.key);
  const feeLines = feeKeys.map((key) => {
    const a = addonByKey.get(key);
    return {
      key,
      label: a?.label || FEE_LABELS[key] || humanizeKey(key),
      magnitude: a ? Math.abs(a.amount_cents) : null,
      isCredit: CREDIT_KEYS.has(key) || (!!a && a.amount_cents < 0),
    };
  });
  const discountLines = addonList.filter((a) => /discount/.test(a.key));

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

  // Annual breakdown: roll the per-installment line items back up by
  // category (Tuition / Extended Day / discounts / prior payments…) so
  // staff see what composes the total. Only meaningful when there's more
  // than one component (FACTS-migrated + add-on plans); a single "Tuition"
  // line hides the card.
  const { rows: breakdown } = await query<{ description: string; amount_cents: number }>(
    `SELECT li.description, SUM(li.amount_cents)::int AS amount_cents
       FROM invoice_line_items li
       JOIN invoices i ON i.id = li.invoice_id
      WHERE i.source = 'tuition_plan'
        AND i.source_ref->>'enrollment_id' = $1
        AND i.school_id = $2 AND i.status <> 'voided'
      GROUP BY li.description
      ORDER BY SUM(li.amount_cents) DESC`,
    [enrollmentId, schoolId],
  );

  // Per-installment fee lines — so each scheduled payment can show (and
  // edit) the fees that compose it (Tuition / Extended Day / Lunch /
  // discounts / prior-payment credits …). Keyed by invoice_id.
  const { rows: lineRows } = await query<FeeLine & { invoice_id: string }>(
    `SELECT li.invoice_id, li.id, li.position, li.description, li.amount_cents, li.category
       FROM invoice_line_items li
       JOIN invoices i ON i.id = li.invoice_id
      WHERE i.source = 'tuition_plan'
        AND i.source_ref->>'enrollment_id' = $1
        AND i.school_id = $2 AND i.status <> 'voided'
      ORDER BY li.invoice_id, li.position, li.id`,
    [enrollmentId, schoolId],
  );
  const linesByInvoice = new Map<string, FeeLine[]>();
  for (const r of lineRows) {
    const arr = linesByInvoice.get(r.invoice_id);
    const fl: FeeLine = { id: r.id, position: r.position, description: r.description, amount_cents: r.amount_cents, category: r.category };
    if (arr) arr.push(fl); else linesByInvoice.set(r.invoice_id, [fl]);
  }

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
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                <StatusPill status={enr.status} />
                {enr.tuition_override_cents === 0
                  && (enr.tuition_override_reason ?? '').startsWith('Migrated from FACTS') ? (
                  // $0 remaining because the family PAID IN FULL in FACTS —
                  // not a scholarship. The migration anchored the plan to the
                  // remaining balance ($0).
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-800" title="Paid in full in FACTS — $0 tuition remaining">
                    ✓ Paid in full
                  </span>
                ) : enr.tuition_override_cents === 0 ? (
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-800">
                    🎓 Scholarship
                  </span>
                ) : enr.tuition_override_cents != null ? (
                  <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-800">
                    ✏️ Custom tuition
                  </span>
                ) : null}
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

        {/* Tuition breakdown — what composes the annual total. Rolled up
            from the invoice line items, so it matches what the parent
            sees on each installment. */}
        {breakdown.length > 1 ? (
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-slate-900 mb-2">
              Tuition breakdown <span className="font-normal text-slate-400">— what makes up the annual total</span>
            </h2>
            <div className="space-y-1 text-sm max-w-md">
              {breakdown.map((b) => (
                <div key={b.description} className="flex justify-between gap-3">
                  <span className="text-slate-700">{b.description}</span>
                  <span className={`tabular-nums font-mono ${b.amount_cents < 0 ? 'text-emerald-700' : 'text-slate-900'}`}>
                    {b.amount_cents < 0 ? '−' : ''}${(Math.abs(b.amount_cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                  </span>
                </div>
              ))}
              <div className="flex justify-between gap-3 border-t border-slate-200 pt-1 font-semibold text-slate-900">
                <span>Annual total</span>
                <span className="tabular-nums font-mono">${(enr.total_annual_cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
              </div>
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              Each installment below carries its own copy of these fees — expand{' '}
              <span className="font-medium text-slate-600">Fee breakdown</span> on any installment to
              see the per-payment amounts, or click <span className="font-medium text-slate-600">Edit</span>{' '}
              to change individual fees on that payment.
            </p>
          </div>
        ) : null}

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

        {/* Tuition override / scholarship — set a custom total tuition
            for this family. Replaces the computed grid+plan+addons math.
            0 = scholarship (no invoices generated). Use cases:
            full / partial scholarship, board-approved discount, special
            adjustment that doesn't fit a discount policy. */}
        <TuitionOverrideEditor
          schoolId={schoolId}
          enrollmentId={enrollmentId}
          returnTo={returnTo}
          overrideCents={enr.tuition_override_cents}
          overrideReason={enr.tuition_override_reason}
          overrideSetBy={enr.tuition_override_set_by_email}
          overrideSetAt={toIso(enr.tuition_override_set_at)}
          currentTotalCents={enr.total_annual_cents}
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

          {!sp.changeplan ? (
            <Link
              href={`${selfHref}?changeplan=1`}
              className="inline-flex items-center gap-1.5 rounded-md border border-violet-300 bg-violet-50 px-3 py-1.5 text-sm font-medium text-violet-800 hover:bg-violet-100"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" /> Change plan
            </Link>
          ) : null}

          {!sp.editfees ? (
            <Link
              href={`${selfHref}?editfees=1`}
              className="inline-flex items-center gap-1.5 rounded-md border border-teal-300 bg-teal-50 px-3 py-1.5 text-sm font-medium text-teal-800 hover:bg-teal-100"
            >
              <Coins className="h-3.5 w-3.5" /> Edit tuition fees
            </Link>
          ) : null}
        </div>

        {/* CHANGE PLAN — swap grid (day-count) and/or payment plan. Discounts
            auto-recompute against the new base; unpaid invoices regenerate. */}
        {sp.changeplan ? (
          <form
            action={`/api/admin/schools/${schoolId}/tuition-plans/${enrollmentId}/action`}
            method="POST"
            className="rounded-xl border-2 border-violet-300 bg-violet-50/30 p-5 space-y-4"
          >
            <input type="hidden" name="action" value="change_plan" />
            <input type="hidden" name="return_to" value={returnTo} />
            <div>
              <h2 className="text-base font-semibold text-violet-900">Change plan</h2>
              <p className="text-xs text-violet-800 mt-0.5">
                Swap this family&rsquo;s program / day-count or payment plan. Percentage discounts
                auto-recompute against the new tuition; add-ons (extended care, deposit, fees)
                carry over. Unpaid installments regenerate at the new total —{' '}
                <strong>paid installments are preserved</strong>.
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="font-medium text-slate-700">Program / tuition</span>
                <select
                  name="new_grid_id"
                  defaultValue={enr.tuition_grid_id}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
                >
                  {Object.entries(gridsByGrade).map(([grade, gs]) => (
                    <optgroup key={grade} label={grade}>
                      {gs.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.display_name} — ${(g.annual_tuition_cents / 100).toLocaleString()}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                <span className="font-medium text-slate-700">Payment plan</span>
                <select
                  name="new_plan_id"
                  defaultValue={enr.payment_plan_id}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
                >
                  {planOpts.map((p) => (
                    <option key={p.id} value={p.id}>{p.display_name}</option>
                  ))}
                </select>
              </label>
            </div>
            <p className="text-[11px] text-violet-700">
              Currently: <strong>{enr.grid_label}</strong> · {enr.plan_label} · ${(enr.total_annual_cents / 100).toLocaleString()}/yr.
              The recomputed breakdown appears above as soon as you apply.
            </p>
            <div className="flex items-center gap-2">
              <button type="submit" className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3.5 py-1.5 text-sm font-semibold text-white hover:bg-violet-700">
                Apply change
              </button>
              <Link href={selfHref} className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
                Cancel
              </Link>
            </div>
          </form>
        ) : null}

        {/* EDIT TUITION FEES — edit the annual fee/credit lines directly.
            Discounts auto-recompute; unpaid invoices + the tuition/DHS
            agreements update together. Keeps the same grid + plan. */}
        {sp.editfees ? (
          <form
            action={`/api/admin/schools/${schoolId}/tuition-plans/${enrollmentId}/action`}
            method="POST"
            className="rounded-xl border-2 border-teal-300 bg-teal-50/30 p-5 space-y-4"
          >
            <input type="hidden" name="action" value="edit_line_items" />
            <input type="hidden" name="return_to" value={returnTo} />
            <div>
              <h2 className="text-base font-semibold text-teal-900">Edit tuition fees</h2>
              <p className="text-xs text-teal-800 mt-0.5">
                Change the fees &amp; credits for this student — extended care, deposit, development
                fee, scholarship. Percentage discounts (prompt-pay, sibling…) recalculate
                automatically. Unpaid installments regenerate at the new total —{' '}
                <strong>paid installments are preserved</strong> — and the tuition &amp; DHS
                agreements update to match.
              </p>
            </div>

            <div className="max-w-lg space-y-2">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="text-slate-600">
                  Base tuition <span className="text-slate-400">(set via &ldquo;Change plan&rdquo;)</span>
                </span>
                <span className="font-mono tabular-nums text-slate-500">
                  ${(enr.base_tuition_cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                </span>
              </div>

              {feeLines.map((f) => (
                <label key={f.key} className="flex items-center justify-between gap-3">
                  <span className="text-sm text-slate-700">
                    {f.label}
                    {f.isCredit ? (
                      <span className="ml-1 rounded bg-emerald-50 px-1 text-[9px] font-semibold uppercase tracking-wide text-emerald-600">credit</span>
                    ) : null}
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="text-xs text-slate-400">{f.isCredit ? '−$' : '$'}</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      name={`fee_${f.key}`}
                      defaultValue={f.magnitude != null ? (f.magnitude / 100).toFixed(2) : ''}
                      placeholder="—"
                      aria-label={`${f.label} amount`}
                      className="w-32 rounded border border-slate-300 bg-white px-2 py-1 text-right font-mono text-sm tabular-nums focus:border-teal-500 focus:outline-none"
                    />
                  </span>
                </label>
              ))}

              {discountLines.length ? (
                <div className="border-t border-teal-200 pt-2 space-y-1">
                  {discountLines.map((d) => (
                    <div key={d.key} className="flex items-center justify-between gap-3 text-xs text-slate-500">
                      <span>{d.label} <span className="text-slate-400">· auto</span></span>
                      <span className="font-mono tabular-nums text-emerald-700">−${(Math.abs(d.amount_cents) / 100).toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="flex items-center justify-between gap-3 border-t border-teal-200 pt-2 text-sm font-semibold text-slate-900">
                <span>Current annual total</span>
                <span className="font-mono tabular-nums">
                  ${(enr.total_annual_cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                </span>
              </div>
            </div>

            <p className="text-[11px] text-teal-700 max-w-lg">
              Leave a fee <strong>blank</strong> to remove it, or enter <strong>0</strong> to show it as
              $0.00 on the agreement. Credits (deposit, scholarship) are entered as a positive number and
              subtract from the total. Discounts recalculate when you save.
            </p>

            <div className="flex items-center gap-2">
              <button type="submit" className="inline-flex items-center gap-1.5 rounded-md bg-teal-600 px-3.5 py-1.5 text-sm font-semibold text-white hover:bg-teal-700">
                Save fees
              </button>
              <Link href={selfHref} className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
                Cancel
              </Link>
            </div>
          </form>
        ) : null}

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
                Voids all currently-open (unpaid) installments and replaces them with a new
                schedule — either <strong>N installments</strong> on a fixed cadence, or a fully{' '}
                <strong>custom</strong> set of dates &amp; amounts (including a single one-off).
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
                  <option value="custom">Custom — I&rsquo;ll enter each date &amp; amount below</option>
                </select>
              </label>
            </div>

            {/* Custom schedule — only read when Cadence = Custom. Full
                flexibility, including a single one-off charge (one line). */}
            <label className="block text-sm">
              <span className="text-[11px] font-medium uppercase tracking-wide text-slate-700">
                Custom schedule <span className="font-normal normal-case text-slate-500">(only used when Cadence = Custom)</span>
              </span>
              <textarea
                name="custom_schedule"
                rows={4}
                placeholder={'One payment per line:  date, amount\n2026-09-01, 500\n2027-01-15, 250'}
                className={`${inputCls} font-mono text-xs`}
              />
              <span className="mt-1 block text-[11px] text-blue-700">
                One line per payment: <code>YYYY-MM-DD, amount</code>. The lines must total{' '}
                <strong>${(balance / 100).toFixed(2)}</strong> (the outstanding balance) — you&rsquo;ll get an alert if they don&rsquo;t.
                For a single one-off charge, enter just one line.
              </span>
            </label>

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
                const recording = sp.record === i.id;
                const isEditable = i.status === 'open' || i.status === 'draft';
                return (
                  <RowOrForm
                    key={i.id}
                    inv={i}
                    lines={linesByInvoice.get(i.id) ?? []}
                    editing={editing}
                    splitting={splitting}
                    recording={recording}
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
  inv, lines, editing, splitting, recording, isEditable, schoolId, locationId, enrollmentId, returnTo, selfHref,
}: {
  inv: InvoiceRow;
  lines: FeeLine[];
  editing: boolean;
  splitting: boolean;
  recording: boolean;
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
    const hasLines = lines.length > 0;
    return (
      <tr className="bg-blue-50/40">
        <td colSpan={7} className="px-4 py-3">
          <form action={`/api/admin/schools/${schoolId}/tuition-plans/${enrollmentId}/action`} method="POST" className="space-y-3">
            <input type="hidden" name="action" value="edit_installment" />
            <input type="hidden" name="invoice_id" value={inv.id} />
            <input type="hidden" name="return_to" value={returnTo} />

            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="text-xs text-slate-600">
                Editing <span className="font-mono">{inv.invoice_number}</span>
                {inv.installment_number ? ` (installment #${inv.installment_number})` : ''}
              </div>
              <label className="block">
                <span className="block text-[10px] font-medium uppercase tracking-wide text-slate-600">Due date</span>
                <input type="date" name="due_date" defaultValue={dueIso} required className={inputCls} />
              </label>
            </div>

            {hasLines ? (
              // Per-fee editor: one input per fee on this installment. Edit
              // only the fees you need — the rest stay as-is — and the
              // installment total is recomputed from the lines on save.
              <div className="rounded-md border border-slate-200 bg-white p-3">
                <div className="mb-2 text-[10px] font-medium uppercase tracking-wide text-slate-500">
                  Fees on this installment — edit any line; leave one blank to keep it unchanged
                </div>
                <div className="max-w-lg space-y-1.5">
                  {lines.map((l) => {
                    const isCredit = l.amount_cents < 0;
                    return (
                      <div key={l.id} className="flex items-center justify-between gap-3">
                        <span className={`text-xs ${isCredit ? 'text-emerald-700' : 'text-slate-700'}`}>
                          {l.description}
                          {isCredit ? (
                            <span className="ml-1 rounded bg-emerald-50 px-1 text-[9px] font-semibold uppercase tracking-wide text-emerald-600">credit</span>
                          ) : null}
                        </span>
                        <div className="flex items-center gap-1">
                          <span className="text-xs text-slate-400">$</span>
                          <input
                            type="number"
                            step="0.01"
                            name={`line_${l.id}`}
                            defaultValue={(l.amount_cents / 100).toFixed(2)}
                            aria-label={`${l.description} amount`}
                            className="w-28 rounded border border-slate-300 bg-white px-2 py-1 text-right font-mono text-sm tabular-nums focus:border-blue-500 focus:outline-none"
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-2 flex max-w-lg justify-between gap-3 border-t border-slate-200 pt-1.5 text-xs font-semibold text-slate-900">
                  <span>Current installment total</span>
                  <span className="font-mono tabular-nums">${amountDollars}</span>
                </div>
                <p className="mt-1 max-w-lg text-[10px] leading-tight text-slate-500">
                  On save, the new total is the sum of the fees above. Credit / discount lines
                  are negative and reduce the total — type a negative value to change one.
                </p>
              </div>
            ) : (
              <label className="block">
                <span className="block text-[10px] font-medium uppercase tracking-wide text-slate-600">Amount ($)</span>
                <input type="number" step="0.01" min="0" name="amount" defaultValue={amountDollars} required className={inputCls} />
              </label>
            )}

            <div className="flex gap-2">
              <button type="submit" className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700">
                Save changes
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

  if (recording) {
    const balanceDollars = ((inv.total_cents - inv.amount_paid_cents) / 100).toFixed(2);
    const todayIso = new Date().toISOString().slice(0, 10);
    return (
      <tr className="bg-emerald-50/40">
        <td colSpan={7} className="px-4 py-3">
          <form action={`/api/admin/schools/${schoolId}/tuition-plans/${enrollmentId}/action`} method="POST" className="space-y-2">
            <input type="hidden" name="action" value="record_payment" />
            <input type="hidden" name="invoice_id" value={inv.id} />
            <input type="hidden" name="return_to" value={returnTo} />
            <div className="text-xs text-slate-700">
              Record an <strong>offline payment</strong> (check, cash, bank transfer) on{' '}
              <span className="font-mono">{inv.invoice_number}</span>. Balance due: <strong>${balanceDollars}</strong>.
              {' '}No card is charged; this just marks the invoice paid.
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <label className="block">
                <span className="block text-[10px] font-medium uppercase tracking-wide text-slate-600">Amount ($)</span>
                <input type="number" step="0.01" min="0" name="amount" defaultValue={balanceDollars} required className={inputCls} />
              </label>
              <label className="block">
                <span className="block text-[10px] font-medium uppercase tracking-wide text-slate-600">Method</span>
                <select name="method" defaultValue="check" className={inputCls}>
                  <option value="check">Check</option>
                  <option value="cash">Cash</option>
                  <option value="bank transfer">Bank transfer</option>
                  <option value="other">Other</option>
                </select>
              </label>
              <label className="block">
                <span className="block text-[10px] font-medium uppercase tracking-wide text-slate-600">Check # / ref</span>
                <input type="text" name="reference" placeholder="e.g. 1234" className={inputCls} />
              </label>
              <label className="block">
                <span className="block text-[10px] font-medium uppercase tracking-wide text-slate-600">Date received</span>
                <input type="date" name="paid_date" defaultValue={todayIso} className={inputCls} />
              </label>
            </div>
            <div className="flex gap-2 pt-1">
              <button type="submit" className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700">
                Record payment
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

  // Show the fee-breakdown toggle only when there's more than one fee to
  // break out, and not on voided rows (nothing to act on).
  const showBreakdown = lines.length > 1 && inv.status !== 'voided';
  const canRecord = inv.status === 'open' || inv.status === 'partially_paid';

  return (
    <>
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
          <div className="inline-flex items-center gap-1">
            {isEditable ? (
              <>
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
              </>
            ) : null}
            {canRecord ? (
              <Link
                href={`${selfHref}?record=${inv.id}`}
                className="inline-flex items-center gap-1 rounded border border-emerald-300 bg-white px-2 py-1 text-[11px] font-medium text-emerald-700 hover:bg-emerald-50"
                title="Record a check / cash / offline payment"
              >
                <Banknote className="h-3 w-3" /> Record
              </Link>
            ) : null}
            {inv.status === 'voided' ? (
              <span className="text-[10px] italic text-slate-400" title={inv.voided_reason ?? ''}>voided</span>
            ) : null}
            {(!isEditable && !canRecord && inv.status !== 'voided') ? (
              <Link href={`/school/${locationId}/payments/invoices/${inv.id}`} className="text-[11px] text-slate-500 hover:text-slate-700 underline">
                view
              </Link>
            ) : null}
          </div>
        </td>
      </tr>

      {/* Per-installment fee breakdown — collapsed by default so the table
          stays compact, expands in place to show the fees that compose
          this scheduled payment (same lines the parent sees + that the
          Edit form lets you change individually). */}
      {showBreakdown ? (
        <tr className="bg-slate-50/40">
          <td />
          <td colSpan={6} className="px-4 pb-2 pt-0">
            <details className="group">
              <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[11px] text-slate-500 hover:text-slate-700">
                <span className="inline-block text-slate-400 transition-transform group-open:rotate-90">▸</span>
                Fee breakdown ({lines.length} items)
              </summary>
              <div className="mt-1.5 ml-4 max-w-md space-y-0.5">
                {lines.map((l) => (
                  <div key={l.id} className="flex justify-between gap-3 text-[11px]">
                    <span className="text-slate-600">{l.description}</span>
                    <span className={`font-mono tabular-nums ${l.amount_cents < 0 ? 'text-emerald-700' : 'text-slate-700'}`}>
                      {l.amount_cents < 0 ? '−' : ''}${(Math.abs(l.amount_cents) / 100).toFixed(2)}
                    </span>
                  </div>
                ))}
                <div className="flex justify-between gap-3 border-t border-slate-200 pt-1 text-[11px] font-semibold text-slate-800">
                  <span>Installment total</span>
                  <span className="font-mono tabular-nums">${(inv.total_cents / 100).toFixed(2)}</span>
                </div>
              </div>
            </details>
          </td>
        </tr>
      ) : null}
    </>
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

// Per-enrollment tuition override editor. Lets the operator set a
// custom annual total — typical use cases: scholarship ($0), partial
// scholarship ($X), board-approved adjustment that doesn't fit a
// formal discount policy. Setting it regenerates installments.
//
// Two states:
//   - No override active (default): shows the current computed total
//     and a "Set custom tuition / Apply scholarship" form, collapsed.
//   - Override active: shows a colored badge with the override + reason
//     + audit, and a smaller "Edit" / "Remove override" form.
function TuitionOverrideEditor({
  schoolId, enrollmentId, returnTo,
  overrideCents, overrideReason, overrideSetBy, overrideSetAt,
  currentTotalCents,
}: {
  schoolId: string;
  enrollmentId: string;
  returnTo: string;
  overrideCents: number | null;
  overrideReason: string | null;
  overrideSetBy: string | null;
  overrideSetAt: string;
  currentTotalCents: number;
}) {
  const hasOverride = overrideCents != null;
  const isScholarship = hasOverride && overrideCents === 0;
  const actionUrl = `/api/admin/schools/${schoolId}/tuition-plans/${enrollmentId}/action`;

  if (hasOverride) {
    return (
      <div className={`rounded-xl border-2 p-4 ${isScholarship ? 'border-emerald-300 bg-emerald-50/40' : 'border-blue-300 bg-blue-50/40'}`}>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="flex items-center gap-2">
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${isScholarship ? 'bg-emerald-200 text-emerald-900' : 'bg-blue-200 text-blue-900'}`}>
                {isScholarship ? '🎓 Scholarship' : '✏️ Custom tuition'}
              </span>
              <span className="font-mono text-base font-semibold text-slate-900">
                ${(overrideCents! / 100).toFixed(2)} / year
              </span>
              {!isScholarship ? (
                <span className="text-xs text-slate-500">(replaces the standard plan amount)</span>
              ) : null}
            </div>
            {overrideReason ? (
              <p className="mt-1 text-xs text-slate-700">
                <span className="font-semibold">Reason:</span> {overrideReason}
              </p>
            ) : null}
            <p className="mt-1 text-[11px] text-slate-500">
              Set {overrideSetAt ? new Date(overrideSetAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'recently'}
              {overrideSetBy ? ` by ${overrideSetBy}` : ''}
            </p>
          </div>
          <details className="group">
            <summary className="cursor-pointer text-xs font-medium text-slate-600 hover:text-slate-900 list-none inline-flex items-center gap-1">
              <span className="text-slate-400 group-open:rotate-90 inline-block transition-transform">▸</span>
              Change or remove
            </summary>
            <form action={actionUrl} method="POST" className="mt-2 space-y-2 rounded-md border border-slate-200 bg-white p-3 min-w-[280px]">
              <input type="hidden" name="action" value="set_tuition_override" />
              <input type="hidden" name="return_to" value={returnTo} />
              <label className="block text-xs">
                <span className="font-medium text-slate-700">New amount ($) — leave blank to clear</span>
                <input
                  type="number"
                  name="override_amount"
                  step="0.01"
                  min="0"
                  defaultValue={(overrideCents! / 100).toFixed(2)}
                  placeholder="e.g. 5000 or blank to remove"
                  className={inputCls}
                />
              </label>
              <label className="block text-xs">
                <span className="font-medium text-slate-700">Reason (optional)</span>
                <input
                  type="text"
                  name="override_reason"
                  defaultValue={overrideReason ?? ''}
                  placeholder="e.g. Full scholarship FY26-27"
                  className={inputCls}
                />
              </label>
              <div className="flex gap-2">
                <button type="submit" className="rounded-md bg-blue-600 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-700">
                  Apply
                </button>
              </div>
              <p className="text-[10px] text-slate-500 leading-tight">
                Blank or &ldquo;clear&rdquo; → reverts to the standard grid + plan total.
                Changing the amount regenerates the unpaid installments.
              </p>
            </form>
          </details>
        </div>
      </div>
    );
  }

  // No override active — collapsed form.
  return (
    <details className="rounded-xl border border-slate-200 bg-slate-50/40 p-4 group">
      <summary className="cursor-pointer list-none flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-slate-400 group-open:rotate-90 inline-block transition-transform">▸</span>
          <span className="text-sm font-semibold text-slate-800">Set custom tuition / Apply scholarship</span>
        </div>
        <span className="text-xs text-slate-500">
          Currently: <span className="font-mono">${(currentTotalCents / 100).toFixed(2)}</span> (standard plan)
        </span>
      </summary>
      <form action={actionUrl} method="POST" className="mt-3 space-y-3 border-t border-slate-200 pt-3">
        <input type="hidden" name="action" value="set_tuition_override" />
        <input type="hidden" name="return_to" value={returnTo} />
        <p className="text-xs text-slate-600 leading-snug">
          Override the standard tuition for this family with a custom amount.
          Useful for scholarships, financial-aid awards, board-approved discounts,
          or any one-off adjustment that doesn&apos;t fit a discount policy.
          Setting <strong>$0</strong> = full scholarship (no invoices generated).
          The plan&apos;s number of installments + due dates stay the same; the
          dollar amount is just spread differently.
        </p>
        <div className="grid sm:grid-cols-[150px_1fr] gap-3">
          <label className="block text-xs">
            <span className="font-medium text-slate-700">Annual tuition ($)</span>
            <input
              type="number"
              name="override_amount"
              step="0.01"
              min="0"
              placeholder="0 for scholarship"
              required
              className={inputCls}
            />
          </label>
          <label className="block text-xs">
            <span className="font-medium text-slate-700">Reason (optional, shown to your records)</span>
            <input
              type="text"
              name="override_reason"
              placeholder='e.g. "Full scholarship FY26-27", "Hardship discount", "Board-approved waiver"'
              maxLength={200}
              className={inputCls}
            />
          </label>
        </div>
        <div className="flex gap-2">
          <button type="submit" className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700">
            Apply custom tuition
          </button>
          <span className="text-[11px] text-slate-500 self-center">
            Replaces any unpaid invoices with the new amount.
          </span>
        </div>
      </form>
    </details>
  );
}
