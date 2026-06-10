// /admin/[schoolId]/payments — operator-facing payment-configuration page.
//
// Sections (Phase 1a + 1b):
//   1. Stripe Connect status
//   2. Billing config (fees, days, late fees, label)
//   3. Payment plans
//   4. Tuition grids

import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  CreditCard, CheckCircle2, AlertTriangle, ExternalLink, Loader2,
  Sparkles, Trash2,
} from 'lucide-react';
import { query } from '@/lib/db';
import { loadPaymentAccount, syncStripeAccountState } from '@/lib/stripe/connect-onboarding';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const CURRENT_YEAR = '2026-27';

type Params = Promise<{ schoolId: string }>;
type SearchParams = Promise<{ stripe?: string; msg?: string; err?: string; year?: string }>;

interface PaymentConfigRow {
  pass_card_fee: boolean;
  pass_ach_fee: boolean;
  processing_fee_label: string;
  autopay_days: number[];
  late_fee_amount_cents: number;
  late_fee_grace_days: number;
  card_enabled: boolean;
  ach_enabled: boolean;
  invoice_number_prefix: string;
  ghl_receipt_webhook_url: string | null;
}

interface TuitionGridRow {
  id: string;
  academic_year: string;
  program: string;
  grade_level: string | null;
  display_name: string;
  annual_tuition_cents: number;
  is_active: boolean;
  position: number;
}

interface PaymentPlanRow {
  id: string;
  slug: string;
  display_name: string;
  description: string | null;
  installment_count: number;
  discount_basis_points: number;
  schedule_template: Record<string, unknown>;
  is_active: boolean;
  position: number;
}

interface DiscountPolicyRow {
  id: string;
  kind: 'auto' | 'code' | 'financial_aid';
  display_name: string;
  percentage_basis_points: number;
  amount_cents: number;
  max_discount_cents: number | null;
  redemption_code: string | null;
  redemption_count: number;
  max_total_redemptions: number | null;
  applies_to_categories: string[];
  conditions: Record<string, unknown>;
  is_active: boolean;
}

interface EnrollmentRow {
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
}

interface FamilyOption { id: string; label: string }

export default async function PaymentsPage({
  params, searchParams,
}: { params: Params; searchParams: SearchParams }) {
  const { schoolId } = await params;
  const sp = await searchParams;
  const yearFilter = sp.year || CURRENT_YEAR;

  const { rows: schoolRows } = await query<{ id: string; name: string }>(
    `SELECT id, name FROM schools WHERE id = $1`, [schoolId],
  );
  if (schoolRows.length === 0) notFound();
  const school = schoolRows[0];

  // If returning from Stripe onboarding, sync the latest state immediately.
  let syncError: string | null = null;
  if (sp.stripe === 'return') {
    const acct = await loadPaymentAccount(schoolId);
    if (acct) {
      try { await syncStripeAccountState(acct.stripe_account_id); }
      catch (e) { syncError = e instanceof Error ? e.message : String(e); }
    }
  }

  const [account, configRows, gridRows, planRows, discountRows, enrollmentRows, familyOptions] = await Promise.all([
    loadPaymentAccount(schoolId),
    query<PaymentConfigRow>(
      `SELECT pass_card_fee, pass_ach_fee, processing_fee_label,
              autopay_days, late_fee_amount_cents, late_fee_grace_days,
              card_enabled, ach_enabled, invoice_number_prefix,
              ghl_receipt_webhook_url
         FROM school_payment_config WHERE school_id = $1`,
      [schoolId],
    ).then((r) => r.rows),
    query<TuitionGridRow>(
      `SELECT id, academic_year, program, grade_level, display_name,
              annual_tuition_cents, is_active, position
         FROM tuition_grids WHERE school_id = $1 AND academic_year = $2
         ORDER BY is_active DESC, position, program`,
      [schoolId, yearFilter],
    ).then((r) => r.rows),
    query<PaymentPlanRow>(
      `SELECT id, slug, display_name, description, installment_count,
              discount_basis_points, schedule_template, is_active, position
         FROM payment_plans WHERE school_id = $1
         ORDER BY is_active DESC, position`,
      [schoolId],
    ).then((r) => r.rows),
    query<DiscountPolicyRow>(
      `SELECT id, kind, display_name, percentage_basis_points, amount_cents,
              max_discount_cents, redemption_code, redemption_count,
              max_total_redemptions, applies_to_categories, conditions, is_active
         FROM discount_policies WHERE school_id = $1
         ORDER BY is_active DESC, kind, display_name`,
      [schoolId],
    ).then((r) => r.rows),
    query<EnrollmentRow>(
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
                AND status = 'paid') AS invoices_paid
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
    ).then((r) => r.rows),
    query<FamilyOption>(
      `SELECT f.id,
              COALESCE(NULLIF(f.display_name, ''),
                       CONCAT_WS(' ', p.first_name, p.last_name),
                       '(unnamed)') AS label
         FROM families f
         LEFT JOIN LATERAL (
           SELECT first_name, last_name FROM parents
           WHERE family_id = f.id AND is_primary = true LIMIT 1
         ) p ON true
        WHERE f.school_id = $1 AND f.status = 'active'
        ORDER BY label
        LIMIT 500`,
      [schoolId],
    ).then((r) => r.rows),
  ]);

  const config: PaymentConfigRow = configRows[0] ?? {
    pass_card_fee: true,
    pass_ach_fee: false,
    processing_fee_label: 'Processing fee',
    autopay_days: [1, 15],
    late_fee_amount_cents: 0,
    late_fee_grace_days: 3,
    card_enabled: true,
    ach_enabled: true,
    invoice_number_prefix: 'INV',
    ghl_receipt_webhook_url: null,
  };

  const isConnected = !!account;
  const isLive = !!(account && account.charges_enabled && account.payouts_enabled);
  const needsMoreInfo = !!(account && account.details_submitted && !account.charges_enabled);
  const inProgress = !!(account && !account.details_submitted);

  return (
    <main className="flex flex-1 flex-col items-center bg-zinc-50 p-6 dark:bg-black">
      <div className="w-full max-w-4xl space-y-5">
        <Link href={`/admin/${schoolId}`} className="text-xs text-zinc-500 hover:text-zinc-700">
          ← {school.name}
        </Link>
        <div className="flex items-baseline justify-between">
          <h1 className="text-2xl font-semibold text-zinc-900">Payments</h1>
          <Link
            href={`/admin/${schoolId}/payments/invoices`}
            className="inline-flex items-center gap-1 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-900 hover:bg-emerald-100"
          >
            Invoices →
          </Link>
        </div>

        {sp.msg ? (
          <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{sp.msg}</div>
        ) : null}
        {sp.err || syncError ? (
          <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{sp.err || syncError}</div>
        ) : null}

        {/* === STRIPE CONNECT === */}
        <section className="rounded-xl border border-black/10 bg-white p-5">
          <div className="flex items-center gap-2 mb-3">
            <CreditCard className="h-5 w-5 text-zinc-700" />
            <h2 className="text-lg font-semibold text-zinc-900">Stripe Connect</h2>
            <StatusPill state={statusOf({ isConnected, isLive, needsMoreInfo, inProgress })} />
          </div>

          {!isConnected ? (
            <ConnectPanel schoolId={schoolId} />
          ) : isLive ? (
            <LivePanel account={account} />
          ) : needsMoreInfo ? (
            <NeedsInfoPanel schoolId={schoolId} account={account} />
          ) : (
            <InProgressPanel schoolId={schoolId} account={account} />
          )}
        </section>

        {/* === BILLING CONFIG === */}
        <section className="rounded-xl border border-black/10 bg-white p-5">
          <h2 className="text-lg font-semibold text-zinc-900 mb-1">Billing configuration</h2>
          <p className="text-xs text-zinc-500 mb-4">
            Governs how every parent payment is processed at this school.
          </p>

          <form action={`/api/admin/schools/${schoolId}/payments/config`} method="POST" className="space-y-4">
            <Subsection title="Payment methods accepted">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <Toggle name="card_enabled" defaultChecked={config.card_enabled} label="Credit / debit cards" />
                <Toggle name="ach_enabled" defaultChecked={config.ach_enabled} label="ACH bank transfer" />
              </div>
            </Subsection>

            <Subsection title="Processing fee pass-through" hint="When enabled, the parent sees the processing fee added to their total. When disabled, the school absorbs it.">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <Toggle name="pass_card_fee" defaultChecked={config.pass_card_fee} label="Pass card fee to parent (2.9% + 30¢)" />
                <Toggle name="pass_ach_fee" defaultChecked={config.pass_ach_fee} label="Pass ACH fee to parent (0.8%, max $5)" />
              </div>
              <Field name="processing_fee_label" label="Fee label parents see" defaultValue={config.processing_fee_label} className="mt-2" />
            </Subsection>

            <Subsection title="Autopay schedule" hint="Comma-separated days of the month autopay can run. Capped at 28 so the day exists in every month.">
              <Field name="autopay_days" label="Allowed days (e.g. 1, 15)" defaultValue={config.autopay_days.join(', ')} />
            </Subsection>

            <Subsection title="Late fee">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <Field name="late_fee_amount" label="Late fee amount ($)" defaultValue={(config.late_fee_amount_cents / 100).toFixed(2)} />
                <Field name="late_fee_grace_days" label="Grace period (days)" defaultValue={String(config.late_fee_grace_days)} />
              </div>
            </Subsection>

            <Subsection title="Invoice numbering">
              <Field name="invoice_number_prefix" label="Invoice prefix (e.g. INV, WOO-)" defaultValue={config.invoice_number_prefix} />
            </Subsection>

            <Subsection
              title="Payment receipts via GoHighLevel"
              hint="Paste a GHL workflow Inbound Webhook URL. On every successful or failed payment we POST the receipt data there, and the school designs the actual email in GHL using their own template. Leave blank to fall back to the built-in Resend email.">
              <Field
                name="ghl_receipt_webhook_url"
                label="GHL inbound webhook URL"
                defaultValue={config.ghl_receipt_webhook_url ?? ''}
              />
              <div className="mt-2 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-[11px] text-zinc-600 leading-relaxed">
                <div className="font-semibold text-zinc-700 mb-1">How to wire it in GHL (one-time, ~3 min):</div>
                <ol className="list-decimal pl-4 space-y-0.5">
                  <li>In GHL → Automation → create a Workflow.</li>
                  <li>Trigger: <span className="font-mono">Inbound Webhook</span> → copy the URL it generates → paste it above &amp; Save.</li>
                  <li>Run one test payment (or click Send test below) so GHL captures a sample payload.</li>
                  <li>Add a <span className="font-mono">Send Email</span> action and drop these merge fields into your template:</li>
                </ol>
                <div className="mt-1.5 font-mono text-[10px] text-zinc-500">
                  {'{{'}inboundWebhookRequest.event{'}}'} · email · first_name · last_name · amount_formatted · invoice_number · invoice_title · card_summary · payment_date · school_name · receipt_url · failure_reason
                </div>
                <div className="mt-1.5">The <span className="font-mono">event</span> field is <span className="font-mono">payment.succeeded</span> or <span className="font-mono">payment.failed</span> — branch on it in the workflow to send a receipt vs. a payment-failed notice.</div>
              </div>
            </Subsection>

            <button type="submit" className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800">
              Save billing config
            </button>
          </form>

          {config.ghl_receipt_webhook_url ? (
            <form action={`/api/admin/schools/${schoolId}/payments/test-receipt-webhook`} method="POST" className="mt-3">
              <button type="submit" className="rounded-md border border-emerald-300 bg-white px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50">
                Send test payload to GHL
              </button>
              <span className="ml-2 text-[11px] text-zinc-500">Fires a sample <span className="font-mono">payment.succeeded</span> so you can confirm the workflow runs.</span>
            </form>
          ) : null}
        </section>

        {/* === QUICK NAV === */}
        <section className="rounded-xl border border-black/10 bg-gradient-to-br from-emerald-50 to-white p-5">
          <h2 className="text-lg font-semibold text-zinc-900 mb-3">Operations</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Link href={`/admin/${schoolId}/payments/facts-import`} className="rounded-md border border-emerald-200 bg-white p-3 hover:border-emerald-400 hover:shadow-sm">
              <div className="text-sm font-semibold text-zinc-900">FACTS import</div>
              <div className="mt-0.5 text-xs text-zinc-600">Paste a FACTS CSV → create/update tuition enrollments in bulk.</div>
            </Link>
            <Link href={`/admin/${schoolId}/payments/products`} className="rounded-md border border-emerald-200 bg-white p-3 hover:border-emerald-400 hover:shadow-sm">
              <div className="text-sm font-semibold text-zinc-900">Product catalog</div>
              <div className="mt-0.5 text-xs text-zinc-600">Anything you charge for that isn&rsquo;t tuition. Events, donations, fundraisers.</div>
            </Link>
            <Link href={`/admin/${schoolId}/payments/purchases`} className="rounded-md border border-emerald-200 bg-white p-3 hover:border-emerald-400 hover:shadow-sm">
              <div className="text-sm font-semibold text-zinc-900">Product purchases</div>
              <div className="mt-0.5 text-xs text-zinc-600">Every charge from the product catalog. Refunds, drilldown, GHL link.</div>
            </Link>
          </div>
        </section>

        {/* === PAYMENT PLANS === */}
        <section className="rounded-xl border border-black/10 bg-white p-5">
          <div className="flex items-baseline justify-between mb-3">
            <div>
              <h2 className="text-lg font-semibold text-zinc-900">Payment plans</h2>
              <p className="text-xs text-zinc-500">Templates parents pick from when setting up tuition. Edit any plan inline.</p>
            </div>
            {planRows.length === 0 ? (
              <form action={`/api/admin/schools/${schoolId}/payments/plans`} method="POST">
                <input type="hidden" name="op" value="seed_defaults" />
                <button type="submit" className="inline-flex items-center gap-1 rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800">
                  <Sparkles className="h-3 w-3" /> Seed defaults
                </button>
              </form>
            ) : null}
          </div>

          {planRows.length === 0 ? (
            <p className="text-sm italic text-zinc-500">No plans yet. Click <strong>Seed defaults</strong> to create the standard 4 (Annual, 2-pay, 4-pay, 10-pay), then customize.</p>
          ) : (
            <ul className="divide-y divide-zinc-100 mb-3">
              {planRows.map((p) => <PlanRow key={p.id} schoolId={schoolId} plan={p} />)}
            </ul>
          )}

          <details className="rounded-md border border-emerald-200 bg-emerald-50/40 px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium text-emerald-900">+ Add custom plan</summary>
            <form action={`/api/admin/schools/${schoolId}/payments/plans`} method="POST" className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input type="hidden" name="op" value="add" />
              <Field name="slug" label="Slug (e.g. monthly-12)" required />
              <Field name="display_name" label="Display name" required />
              <Field name="installment_count" label="Installment count" defaultValue="1" />
              <Field name="discount_pct" label="Discount % (e.g. 2.5)" defaultValue="0" />
              <Field name="description" label="Description (optional)" className="sm:col-span-2" />
              <button type="submit" className="sm:col-span-2 mt-1 rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800 self-start">
                Add plan
              </button>
            </form>
          </details>
        </section>

        {/* === TUITION GRIDS === */}
        <section className="rounded-xl border border-black/10 bg-white p-5">
          <div className="flex items-baseline justify-between mb-3">
            <div>
              <h2 className="text-lg font-semibold text-zinc-900">Tuition grids · {yearFilter}</h2>
              <p className="text-xs text-zinc-500">
                One row per program / grade level. Forms can auto-calculate based on these.
              </p>
            </div>
            <form action={`/admin/${schoolId}/payments`} method="GET" className="inline-flex items-center gap-1 text-xs">
              <span className="text-zinc-500">year:</span>
              <input
                type="text" name="year" defaultValue={yearFilter}
                className="w-20 rounded border border-zinc-300 px-1 py-0.5 font-mono"
              />
              <button type="submit" className="rounded border border-zinc-300 bg-white px-2 py-0.5 hover:bg-zinc-50">Go</button>
            </form>
          </div>

          {gridRows.length === 0 ? (
            <p className="text-sm italic text-zinc-500 mb-3">No grids for {yearFilter}. Add one below.</p>
          ) : (
            <ul className="divide-y divide-zinc-100 mb-3">
              {gridRows.map((g) => <GridRow key={g.id} schoolId={schoolId} grid={g} />)}
            </ul>
          )}

          <details className="rounded-md border border-emerald-200 bg-emerald-50/40 px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium text-emerald-900">+ Add tuition grid row</summary>
            <form action={`/api/admin/schools/${schoolId}/payments/tuition-grids`} method="POST" className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input type="hidden" name="op" value="add" />
              <Field name="academic_year" label="Academic year" defaultValue={yearFilter} />
              <Field name="program" label="Program (e.g. Preschool, K)" required />
              <Field name="grade_level" label="Grade level (optional)" />
              <Field name="display_name" label="Display name" />
              <Field name="annual_tuition" label="Annual tuition ($)" required />
              <button type="submit" className="sm:col-span-2 mt-1 rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800 self-start">
                Add row
              </button>
            </form>
          </details>
        </section>

        {/* === FAMILY TUITION ENROLLMENTS === */}
        <section className="rounded-xl border border-black/10 bg-white p-5">
          <div className="flex items-baseline justify-between mb-3">
            <div>
              <h2 className="text-lg font-semibold text-zinc-900">Family payment plans</h2>
              <p className="text-xs text-zinc-500">
                Enroll a family on a tuition + payment-plan combo. We generate
                one invoice per installment with the correct due dates,
                applying any matching discount policies automatically.
              </p>
            </div>
          </div>

          {enrollmentRows.length === 0 ? (
            <p className="text-sm italic text-zinc-500 mb-3">
              No families are enrolled in a plan yet. Use the form below to set one up.
            </p>
          ) : (
            <ul className="divide-y divide-zinc-100 mb-3">
              {enrollmentRows.map((e) => <EnrollmentRowItem key={e.id} schoolId={schoolId} e={e} />)}
            </ul>
          )}

          <details className="rounded-md border border-emerald-200 bg-emerald-50/40 px-3 py-3">
            <summary className="cursor-pointer text-sm font-medium text-emerald-900">+ Set up a payment plan for a family</summary>
            <form action={`/api/admin/schools/${schoolId}/payments/enrollments`} method="POST" className="mt-3 space-y-3">
              <input type="hidden" name="op" value="create" />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <label className="block">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-600">Family *</span>
                  <select name="family_id" required className="mt-0.5 w-full rounded border border-zinc-300 px-2 py-1 text-sm">
                    <option value="">— select a family —</option>
                    {familyOptions.map((f) => (
                      <option key={f.id} value={f.id}>{f.label}</option>
                    ))}
                  </select>
                </label>
                <Field name="student_id" label="Student ID (optional — leave blank for single-child families)" />
                <Field name="academic_year" label="Academic year *" defaultValue={yearFilter} required />
                <label className="block">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-600">Tuition grid *</span>
                  <select name="tuition_grid_id" required className="mt-0.5 w-full rounded border border-zinc-300 px-2 py-1 text-sm">
                    <option value="">— select a tuition level —</option>
                    {gridRows.filter((g) => g.is_active).map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.display_name} · {g.academic_year} · ${(g.annual_tuition_cents / 100).toFixed(0)}/yr
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-600">Payment plan *</span>
                  <select name="payment_plan_id" required className="mt-0.5 w-full rounded border border-zinc-300 px-2 py-1 text-sm">
                    <option value="">— select a plan —</option>
                    {planRows.filter((p) => p.is_active).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.display_name} ({p.installment_count} installments
                        {p.discount_basis_points > 0 ? `, save ${(p.discount_basis_points / 100).toFixed(1)}%` : ''})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-600">Initial status</span>
                  <select name="initial_status" defaultValue="open" className="mt-0.5 w-full rounded border border-zinc-300 px-2 py-1 text-sm">
                    <option value="open">Open (parent sees installments immediately)</option>
                    <option value="draft">Draft (operator sends them later)</option>
                  </select>
                </label>
              </div>
              <Field name="internal_note" label="Internal note (optional)" />
              <p className="text-[11px] text-zinc-500">
                Add-on selection isn&rsquo;t in this admin form yet — pre-select required
                add-ons by marking them <code>required: true</code> on the tuition grid,
                or use the parent-facing form with a <code>tuition_calculator</code> field.
              </p>
              <button type="submit" className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800">
                Set up plan &amp; generate invoices
              </button>
            </form>
          </details>
        </section>

        {/* === DISCOUNTS === */}
        <section className="rounded-xl border border-black/10 bg-white p-5">
          <div className="flex items-baseline justify-between mb-3">
            <div>
              <h2 className="text-lg font-semibold text-zinc-900">Discounts</h2>
              <p className="text-xs text-zinc-500">
                Auto-apply rules (sibling discounts, early-bird), parent-redeemable codes,
                and financial-aid awards. Applied at invoice creation.
              </p>
            </div>
          </div>

          {discountRows.length === 0 ? (
            <p className="text-sm italic text-zinc-500 mb-3">No discount policies yet. Add one below.</p>
          ) : (
            <ul className="divide-y divide-zinc-100 mb-3">
              {discountRows.map((d) => <DiscountRow key={d.id} schoolId={schoolId} d={d} />)}
            </ul>
          )}

          <details className="rounded-md border border-emerald-200 bg-emerald-50/40 px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium text-emerald-900">+ Add discount policy</summary>
            <form action={`/api/admin/schools/${schoolId}/payments/discounts`} method="POST" className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input type="hidden" name="op" value="add" />
              <label className="block">
                <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-600">Kind</span>
                <select name="kind" className="mt-0.5 w-full rounded border border-zinc-300 bg-white px-2 py-1 text-sm">
                  <option value="auto">Auto-apply</option>
                  <option value="code">Redemption code</option>
                  <option value="financial_aid">Financial aid award</option>
                </select>
              </label>
              <Field name="display_name" label="Display name (shown to parent)" required />
              <Field name="percentage_pct" label="Percent off (0–100, blank for flat $)" />
              <Field name="amount_dollars" label="Flat $ off (blank for %)" />
              <Field name="max_discount_dollars" label="Max discount $ (optional cap)" />
              <Field name="redemption_code" label="Redemption code (kind=code only)" />
              <Field name="max_total_redemptions" label="Max total uses (kind=code, optional)" />
              <Field name="applies_to_categories" label="Categories (CSV; blank = all)" />
              <Field name="fa_application_id" label="FA application ID (kind=financial_aid only)" />
              <Field name="conditions_json" label='Conditions JSON (e.g. {"min_children_enrolled": 2})' className="sm:col-span-2" />
              <button type="submit" className="sm:col-span-2 mt-1 rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800 self-start">
                Add discount
              </button>
            </form>
          </details>
        </section>
      </div>
    </main>
  );
}

function EnrollmentRowItem({ schoolId, e }: { schoolId: string; e: EnrollmentRow }) {
  const monthly = e.installment_count > 0 ? Math.round(e.total_annual_cents / e.installment_count) : e.total_annual_cents;
  const statusClass =
    e.status === 'active'    ? 'bg-emerald-100 text-emerald-800' :
    e.status === 'paused'    ? 'bg-amber-100 text-amber-800' :
    e.status === 'completed' ? 'bg-blue-100 text-blue-800' :
                               'bg-zinc-100 text-zinc-700';
  return (
    <li className="py-2.5 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-zinc-900">{e.family_label}</span>
          {e.student_label ? (
            <span className="text-xs text-zinc-600">· {e.student_label}</span>
          ) : null}
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${statusClass}`}>
            {e.status}
          </span>
          <span className="text-[10px] font-mono text-zinc-500">{e.academic_year}</span>
        </div>
        <div className="text-[11px] text-zinc-600 mt-0.5">
          {e.grid_label} · {e.plan_label} ·{' '}
          <span className="font-medium text-zinc-800">${(e.total_annual_cents / 100).toFixed(2)}/yr</span>
          {e.installment_count > 1 ? (
            <> · ${(monthly / 100).toFixed(2)} × {e.installment_count}</>
          ) : null}
          <> · </>
          <span className="text-emerald-700">{e.invoices_paid} paid</span>
          <> · </>
          <span className="text-amber-700">{e.invoices_open} open</span>
        </div>
      </div>
      {e.status === 'active' ? (
        <form action={`/api/admin/schools/${schoolId}/payments/enrollments`} method="POST">
          <input type="hidden" name="op" value="cancel" />
          <input type="hidden" name="enrollment_id" value={e.id} />
          <button
            type="submit"
            className="rounded border border-rose-300 bg-white px-2 py-1 text-[11px] font-medium text-rose-700 hover:bg-rose-50"
            title="Cancel enrollment and void unpaid invoices"
          >
            Cancel
          </button>
        </form>
      ) : null}
    </li>
  );
}

function DiscountRow({ schoolId, d }: { schoolId: string; d: DiscountPolicyRow }) {
  const kindLabel = d.kind === 'auto' ? 'AUTO' : d.kind === 'code' ? 'CODE' : 'FA';
  const kindClass =
    d.kind === 'auto' ? 'bg-blue-100 text-blue-800' :
    d.kind === 'code' ? 'bg-violet-100 text-violet-800' :
                        'bg-amber-100 text-amber-800';
  const amount = d.percentage_basis_points > 0
    ? `${(d.percentage_basis_points / 100).toFixed(1)}%`
    : `$${(d.amount_cents / 100).toFixed(2)}`;
  return (
    <li className="py-2.5">
      <form action={`/api/admin/schools/${schoolId}/payments/discounts`} method="POST" className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center">
        <input type="hidden" name="op" value="update" />
        <input type="hidden" name="id" value={d.id} />
        <div className="sm:col-span-1">
          <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide ${kindClass}`}>{kindLabel}</span>
        </div>
        <div className="sm:col-span-5">
          <input
            type="text" name="display_name" defaultValue={d.display_name}
            className="w-full rounded border border-zinc-300 px-2 py-1 text-sm"
          />
          {d.redemption_code ? (
            <div className="text-[10px] text-zinc-500 mt-0.5 font-mono">
              code: <strong>{d.redemption_code}</strong>
              {' · '}{d.redemption_count} use{d.redemption_count === 1 ? '' : 's'}
              {d.max_total_redemptions ? ` / ${d.max_total_redemptions}` : ''}
            </div>
          ) : (
            <div className="text-[10px] text-zinc-500 mt-0.5">
              {d.applies_to_categories.length > 0 ? `cats: ${d.applies_to_categories.join(', ')}` : 'all categories'}
              {Object.keys(d.conditions).length > 0 ? ` · ${JSON.stringify(d.conditions)}` : ''}
            </div>
          )}
        </div>
        <div className="sm:col-span-2 text-sm text-right tabular-nums font-mono">{amount}</div>
        <div className="sm:col-span-2 text-xs text-zinc-500 text-right">
          {d.max_discount_cents != null ? `max $${(d.max_discount_cents / 100).toFixed(0)}` : ''}
        </div>
        <label className="sm:col-span-1 flex items-center justify-center gap-1 text-xs">
          <input type="checkbox" name="is_active" value="1" defaultChecked={d.is_active} />
          active
        </label>
        <div className="sm:col-span-1 flex justify-end">
          <button type="submit" className="rounded bg-zinc-900 px-2 py-1 text-xs text-white hover:bg-zinc-800">save</button>
        </div>
      </form>
    </li>
  );
}

// ─── shared UI helpers ────────────────────────────────────────────────

function Subsection({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-zinc-100 pt-3 first:border-t-0 first:pt-0">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-600">{title}</h3>
      {hint ? <p className="text-[11px] text-zinc-500 mt-0.5">{hint}</p> : null}
      <div className="mt-2">{children}</div>
    </div>
  );
}

function Toggle({ name, defaultChecked, label }: { name: string; defaultChecked: boolean; label: string }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" name={name} value="1" defaultChecked={defaultChecked} className="h-4 w-4 rounded border-zinc-300" />
      <span>{label}</span>
    </label>
  );
}

function Field({ name, label, defaultValue, required, className }:
  { name: string; label: string; defaultValue?: string; required?: boolean; className?: string }) {
  return (
    <label className={`block ${className ?? ''}`}>
      <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-600">{label}</span>
      <input
        type="text" name={name} defaultValue={defaultValue ?? ''} required={required}
        className="mt-0.5 w-full rounded border border-zinc-300 bg-white px-2 py-1 text-sm focus:border-emerald-600 focus:outline-none"
      />
    </label>
  );
}

function PlanRow({ schoolId, plan }: { schoolId: string; plan: PaymentPlanRow }) {
  return (
    <li className="py-2.5">
      <form action={`/api/admin/schools/${schoolId}/payments/plans`} method="POST" className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center">
        <input type="hidden" name="op" value="update" />
        <input type="hidden" name="id" value={plan.id} />
        <div className="sm:col-span-4">
          <input
            type="text" name="display_name" defaultValue={plan.display_name}
            className="w-full rounded border border-zinc-300 px-2 py-1 text-sm"
          />
          <div className="text-[10px] text-zinc-500 mt-0.5 font-mono">{plan.slug} · {plan.installment_count} installments</div>
        </div>
        <div className="sm:col-span-5">
          <input
            type="text" name="description" defaultValue={plan.description ?? ''}
            placeholder="Description (optional)"
            className="w-full rounded border border-zinc-300 px-2 py-1 text-xs"
          />
        </div>
        <div className="sm:col-span-1">
          <input
            type="number" name="discount_pct" step="0.1" min="0"
            defaultValue={(plan.discount_basis_points / 100).toFixed(1)}
            className="w-full rounded border border-zinc-300 px-1 py-1 text-xs text-right"
            title="Discount %"
          />
        </div>
        <label className="sm:col-span-1 flex items-center justify-center gap-1 text-xs">
          <input type="checkbox" name="is_active" value="1" defaultChecked={plan.is_active} />
          active
        </label>
        <div className="sm:col-span-1 flex justify-end">
          <button type="submit" className="rounded bg-zinc-900 px-2 py-1 text-xs text-white hover:bg-zinc-800">save</button>
        </div>
      </form>
    </li>
  );
}

function GridRow({ schoolId, grid }: { schoolId: string; grid: TuitionGridRow }) {
  return (
    <li className="py-2.5">
      <form action={`/api/admin/schools/${schoolId}/payments/tuition-grids`} method="POST" className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center">
        <input type="hidden" name="op" value="update" />
        <input type="hidden" name="id" value={grid.id} />
        <div className="sm:col-span-5">
          <input
            type="text" name="display_name" defaultValue={grid.display_name}
            className="w-full rounded border border-zinc-300 px-2 py-1 text-sm"
          />
          <div className="text-[10px] text-zinc-500 mt-0.5">{grid.program}{grid.grade_level ? ` · ${grid.grade_level}` : ''}</div>
        </div>
        <div className="sm:col-span-3">
          <div className="flex items-center">
            <span className="text-zinc-400 text-xs mr-1">$</span>
            <input
              type="number" name="annual_tuition" step="0.01"
              defaultValue={(grid.annual_tuition_cents / 100).toFixed(2)}
              className="w-full rounded border border-zinc-300 px-1 py-1 text-sm text-right"
            />
            <span className="text-[10px] text-zinc-500 ml-1">/yr</span>
          </div>
        </div>
        <label className="sm:col-span-2 flex items-center gap-1 text-xs">
          <input type="checkbox" name="is_active" value="1" defaultChecked={grid.is_active} />
          active
        </label>
        <div className="sm:col-span-2 flex gap-1 justify-end">
          <button type="submit" className="rounded bg-zinc-900 px-2 py-1 text-xs text-white hover:bg-zinc-800">save</button>
          <button
            type="submit" formAction={`/api/admin/schools/${schoolId}/payments/tuition-grids`}
            name="op" value="delete"
            className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-600 hover:bg-rose-50 hover:text-rose-700"
            title="Deactivate"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </form>
    </li>
  );
}

// ─── Stripe Connect status panels (unchanged from Phase 1a) ──────────

function statusOf(s: { isConnected: boolean; isLive: boolean; needsMoreInfo: boolean; inProgress: boolean }):
  'not_connected' | 'in_progress' | 'needs_info' | 'live' {
  if (s.isLive) return 'live';
  if (s.needsMoreInfo) return 'needs_info';
  if (s.inProgress) return 'in_progress';
  return 'not_connected';
}

function StatusPill({ state }: { state: 'not_connected' | 'in_progress' | 'needs_info' | 'live' }) {
  const map = {
    not_connected: { label: 'Not connected', bg: 'bg-zinc-100', fg: 'text-zinc-600' },
    in_progress:   { label: 'Onboarding in progress', bg: 'bg-amber-100', fg: 'text-amber-800' },
    needs_info:    { label: 'Stripe needs more info', bg: 'bg-amber-100', fg: 'text-amber-800' },
    live:          { label: 'Live — accepting payments', bg: 'bg-emerald-100', fg: 'text-emerald-800' },
  } as const;
  const cfg = map[state];
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${cfg.bg} ${cfg.fg}`}>
      {cfg.label}
    </span>
  );
}

function ConnectPanel({ schoolId }: { schoolId: string }) {
  return (
    <div className="rounded-md border border-emerald-200 bg-emerald-50/40 p-4">
      <p className="text-sm text-zinc-700">
        Connect a Stripe account to start accepting tuition and other payments. The school
        creates a Stripe account (or signs into one they already own) — takes about 5 minutes.
        They&rsquo;ll need their EIN, bank account, and a person of significant ownership on file.
      </p>
      <form action={`/api/admin/schools/${schoolId}/payments/connect`} method="POST" className="mt-3">
        <button
          type="submit"
          className="inline-flex items-center gap-1.5 rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800"
        >
          <CreditCard className="h-4 w-4" /> Connect Stripe
        </button>
      </form>
    </div>
  );
}

function InProgressPanel({ schoolId, account }: { schoolId: string; account: { stripe_account_id: string } }) {
  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 p-4 space-y-2">
      <div className="flex items-start gap-2">
        <Loader2 className="h-4 w-4 text-amber-700 mt-0.5" />
        <div className="text-sm">
          <div className="font-semibold text-amber-900">Onboarding started, not yet completed</div>
          <div className="mt-0.5 text-xs text-amber-800">
            Stripe account <code className="font-mono">{account.stripe_account_id}</code> exists,
            but the school hasn&rsquo;t finished entering their business details.
          </div>
        </div>
      </div>
      <form action={`/api/admin/schools/${schoolId}/payments/connect`} method="POST">
        <button type="submit" className="rounded-md border border-amber-400 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100">
          Resume Stripe onboarding ↗
        </button>
      </form>
    </div>
  );
}

function NeedsInfoPanel({ schoolId, account }: {
  schoolId: string;
  account: { stripe_account_id: string; requirements_currently_due: string[] | null };
}) {
  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 p-4 space-y-2">
      <div className="flex items-start gap-2">
        <AlertTriangle className="h-4 w-4 text-amber-700 mt-0.5" />
        <div className="text-sm">
          <div className="font-semibold text-amber-900">Stripe needs more information</div>
          {(account.requirements_currently_due ?? []).length > 0 ? (
            <ul className="mt-1 list-disc pl-5 text-xs text-amber-900">
              {(account.requirements_currently_due ?? []).map((r) => (
                <li key={r}><code className="font-mono">{r}</code></li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
      <form action={`/api/admin/schools/${schoolId}/payments/connect`} method="POST">
        <button type="submit" className="rounded-md border border-amber-400 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100">
          Complete Stripe requirements ↗
        </button>
      </form>
    </div>
  );
}

function LivePanel({ account }: { account: {
  stripe_account_id: string;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  last_synced_at: Date | null;
} }) {
  return (
    <div className="rounded-md border border-emerald-200 bg-emerald-50 p-4 space-y-2">
      <div className="flex items-start gap-2">
        <CheckCircle2 className="h-4 w-4 text-emerald-700 mt-0.5" />
        <div className="text-sm">
          <div className="font-semibold text-emerald-900">Connected · Ready to accept payments</div>
          <div className="mt-0.5 text-xs text-emerald-800">
            All parent payments will settle directly into this Stripe account.
            <br />Account: <code className="font-mono">{account.stripe_account_id}</code>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs text-emerald-800">
        <a href={`https://dashboard.stripe.com/${account.stripe_account_id}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline">
          Open Stripe dashboard <ExternalLink className="h-3 w-3" />
        </a>
        {account.last_synced_at ? (
          <span className="text-[11px]">Last synced {new Date(account.last_synced_at).toLocaleString()}</span>
        ) : null}
      </div>
    </div>
  );
}
