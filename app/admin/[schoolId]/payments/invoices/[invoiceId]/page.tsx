// /admin/[schoolId]/payments/invoices/[invoiceId] — single invoice view.
//
// Shows the invoice header, line items, payment attempts, and admin
// actions (send if draft, void, copy parent-pay URL).

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Send, Ban, Zap, ZapOff } from 'lucide-react';
import { query } from '@/lib/db';
import { CopyButton } from './CopyButton';

export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string; invoiceId: string }>;
type SearchParams = Promise<{ msg?: string; err?: string }>;

interface InvoiceRow {
  id: string;
  invoice_number: string;
  family_id: string | null;
  family_label: string;
  student_label: string | null;
  bill_to_label: string | null;
  recipient_email: string | null;
  public_pay_token: string | null;
  title: string;
  description: string | null;
  status: string;
  subtotal_cents: number;
  platform_fee_cents: number;
  processing_fee_cents: number;
  discount_total_cents: number;
  total_cents: number;
  amount_paid_cents: number;
  due_at: string;
  issued_at: string | null;
  paid_at: string | null;
  voided_at: string | null;
  voided_reason: string | null;
  includes_platform_setup_fee: boolean;
  created_at: string;
  created_by_email: string | null;
  autopay_enabled: boolean;
  autopay_payment_method_id: string | null;
  autopay_charge_on: string | null;
  next_retry_at: string | null;
  retry_attempt_count: number;
  last_autopay_attempted_at: string | null;
}

interface PaymentMethodOption {
  id: string;
  type: 'card' | 'us_bank_account';
  brand: string | null;
  last4: string | null;
  is_default: boolean;
}

interface LineRow {
  id: string;
  position: number;
  description: string;
  quantity: number;
  unit_amount_cents: number;
  amount_cents: number;
}

interface PaymentRow {
  id: string;
  amount_cents: number;
  fee_cents: number;
  platform_fee_cents: number;
  status: string;
  stripe_payment_method_type: string | null;
  failure_message: string | null;
  created_at: string;
}

export default async function InvoiceDetail({
  params, searchParams,
}: { params: Params; searchParams: SearchParams }) {
  const { schoolId, invoiceId } = await params;
  const sp = await searchParams;

  const { rows } = await query<InvoiceRow>(
    `SELECT i.id, i.invoice_number, i.family_id,
            COALESCE(NULLIF(f.display_name, ''),
                     CONCAT_WS(' ', p.first_name, p.last_name),
                     i.recipient_name,
                     i.recipient_email,
                     '(unnamed)') AS family_label,
            CASE WHEN i.student_id IS NULL THEN NULL
                 ELSE CONCAT_WS(' ', COALESCE(NULLIF(st.preferred_name, ''), st.first_name), st.last_name) END AS student_label,
            CASE WHEN i.responsible_parent_id IS NULL THEN NULL
                 ELSE CONCAT_WS(' ', rp.first_name, rp.last_name) END AS bill_to_label,
            i.recipient_email, i.public_pay_token,
            i.title, i.description, i.status,
            i.subtotal_cents, i.platform_fee_cents, i.processing_fee_cents,
            i.discount_total_cents, i.total_cents, i.amount_paid_cents,
            i.due_at, i.issued_at, i.paid_at, i.voided_at, i.voided_reason,
            i.includes_platform_setup_fee,
            i.created_at, i.created_by_email,
            i.autopay_enabled, i.autopay_payment_method_id,
            i.autopay_charge_on, i.next_retry_at,
            i.retry_attempt_count, i.last_autopay_attempted_at
       FROM invoices i
       LEFT JOIN families f ON f.id = i.family_id
       LEFT JOIN students st ON st.id = i.student_id
       LEFT JOIN parents rp ON rp.id = i.responsible_parent_id
       LEFT JOIN LATERAL (
         SELECT first_name, last_name FROM parents
         WHERE family_id = i.family_id AND is_primary = true LIMIT 1
       ) p ON true
      WHERE i.school_id = $1 AND i.id = $2`,
    [schoolId, invoiceId],
  );
  const inv = rows[0];
  if (!inv) notFound();

  const { rows: lines } = await query<LineRow>(
    `SELECT id, position, description, quantity, unit_amount_cents, amount_cents
       FROM invoice_line_items WHERE invoice_id = $1 ORDER BY position`,
    [invoiceId],
  );

  const { rows: pays } = await query<PaymentRow>(
    `SELECT id, amount_cents, fee_cents, platform_fee_cents, status,
            stripe_payment_method_type, failure_message, created_at
       FROM payments WHERE invoice_id = $1 ORDER BY created_at DESC`,
    [invoiceId],
  );

  // Family's saved payment methods — drives the autopay enable form.
  const { rows: methods } = await query<PaymentMethodOption>(
    `SELECT id, type, brand, last4, is_default
       FROM payment_methods
      WHERE school_id = $1 AND family_id = $2 AND active = true
      ORDER BY is_default DESC, created_at DESC`,
    [schoolId, inv.family_id],
  );

  // Pay URL — what the recipient clicks. Prefer the public tokenized
  // link (works for anyone, no login — required for non-family invoices
  // and convenient for everyone). Falls back to the session pay page.
  const portalBase = process.env.PARENT_PORTAL_BASE_URL ?? 'https://growth-suite-parent-portal.vercel.app';
  const parentPayUrl = inv.public_pay_token
    ? `${portalBase}/pay/invoice/${inv.id}?t=${inv.public_pay_token}`
    : `${portalBase}/billing/pay/${inv.id}`;

  return (
    <main className="flex flex-1 flex-col items-center bg-zinc-50 p-6 dark:bg-black">
      <div className="w-full max-w-3xl space-y-4">
        <Link href={`/admin/${schoolId}/payments/invoices`} className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-700">
          <ArrowLeft className="h-3 w-3" /> Invoices
        </Link>

        {sp.msg ? (
          <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{sp.msg}</div>
        ) : null}
        {sp.err ? (
          <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{sp.err}</div>
        ) : null}

        <div className="rounded-xl border border-black/10 bg-white p-6 space-y-5">
          <div className="flex items-baseline justify-between">
            <div>
              <div className="font-mono text-xs text-zinc-500">{inv.invoice_number}</div>
              <h1 className="text-xl font-semibold text-zinc-900 mt-1">{inv.title}</h1>
              <p className="text-sm text-zinc-600 mt-1">{inv.family_label}</p>
              {inv.student_label ? (
                <p className="text-xs text-zinc-500 mt-0.5">
                  Student: <span className="font-medium text-zinc-700">{inv.student_label}</span>
                </p>
              ) : null}
              {inv.bill_to_label ? (
                <p className="text-xs text-zinc-500 mt-0.5">
                  Bill to: <span className="font-medium text-zinc-700">{inv.bill_to_label} only</span>
                </p>
              ) : null}
            </div>
            <StatusPill status={inv.status} />
          </div>

          {inv.description ? <p className="text-sm text-zinc-700">{inv.description}</p> : null}

          <div className="rounded-md border border-zinc-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-left text-[10px] uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="px-3 py-2 font-medium">Description</th>
                  <th className="px-2 py-2 font-medium text-right">Qty</th>
                  <th className="px-2 py-2 font-medium text-right">Unit</th>
                  <th className="px-3 py-2 font-medium text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {lines.map((l) => {
                  const isDiscount = l.amount_cents < 0;
                  return (
                    <tr key={l.id} className={isDiscount ? 'text-emerald-700' : ''}>
                      <td className="px-3 py-2">{l.description}</td>
                      <td className="px-2 py-2 text-right text-zinc-600">{l.quantity}</td>
                      <td className="px-2 py-2 text-right font-mono">
                        {isDiscount ? '−' : ''}${(Math.abs(l.unit_amount_cents) / 100).toFixed(2)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {isDiscount ? '−' : ''}${(Math.abs(l.amount_cents) / 100).toFixed(2)}
                      </td>
                    </tr>
                  );
                })}
                <tr className="border-t-2 border-zinc-200">
                  <td colSpan={3} className="px-3 py-2 text-right text-zinc-600">Subtotal (before discounts)</td>
                  <td className="px-3 py-2 text-right font-mono">${(inv.subtotal_cents / 100).toFixed(2)}</td>
                </tr>
                {inv.discount_total_cents > 0 ? (
                  <tr>
                    <td colSpan={3} className="px-3 py-2 text-right text-emerald-700">Discounts applied</td>
                    <td className="px-3 py-2 text-right font-mono text-emerald-700">−${(inv.discount_total_cents / 100).toFixed(2)}</td>
                  </tr>
                ) : null}
                {inv.platform_fee_cents > 0 ? (
                  <tr>
                    <td colSpan={3} className="px-3 py-2 text-right text-zinc-600">
                      One-Time Setup Fee
                      <span className="ml-1 text-[10px] text-zinc-400">(one-time, payment processor)</span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono">${(inv.platform_fee_cents / 100).toFixed(2)}</td>
                  </tr>
                ) : null}
                <tr className="bg-zinc-50 font-semibold">
                  <td colSpan={3} className="px-3 py-2 text-right text-zinc-900">Total (parent pays processing fee on top, depending on rail)</td>
                  <td className="px-3 py-2 text-right font-mono text-zinc-900">${(inv.total_cents / 100).toFixed(2)}</td>
                </tr>
                {inv.amount_paid_cents > 0 ? (
                  <tr className="bg-emerald-50">
                    <td colSpan={3} className="px-3 py-2 text-right text-emerald-700">Paid to date</td>
                    <td className="px-3 py-2 text-right font-mono text-emerald-800">${(inv.amount_paid_cents / 100).toFixed(2)}</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          {/* Dates */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
            <DateField label="Created" value={inv.created_at} />
            <DateField label="Due" value={inv.due_at} />
            {inv.issued_at ? <DateField label="Sent" value={inv.issued_at} /> : null}
            {inv.paid_at ? <DateField label="Paid" value={inv.paid_at} /> : null}
          </div>

          {/* Autopay panel — only relevant for open / partially-paid invoices */}
          {inv.status !== 'voided' && inv.status !== 'paid' ? (
            <AutopayPanel
              schoolId={schoolId}
              invoiceId={inv.id}
              enabled={inv.autopay_enabled}
              currentMethodId={inv.autopay_payment_method_id}
              chargeOn={inv.autopay_charge_on}
              dueAt={inv.due_at}
              retryAttemptCount={inv.retry_attempt_count}
              nextRetryAt={inv.next_retry_at}
              lastAttemptedAt={inv.last_autopay_attempted_at}
              methods={methods}
            />
          ) : null}

          {/* Actions */}
          <div className="flex flex-wrap gap-2 pt-3 border-t border-zinc-100">
            {inv.status === 'draft' ? (
              <form action={`/api/admin/schools/${schoolId}/payments/invoices/${invoiceId}/send`} method="POST">
                <button type="submit" className="inline-flex items-center gap-1 rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800">
                  <Send className="h-3.5 w-3.5" /> Send to parent
                </button>
              </form>
            ) : null}
            {(inv.status === 'open' || inv.status === 'draft') ? (
              <CopyButton url={parentPayUrl} />
            ) : null}
            {inv.status !== 'voided' && inv.status !== 'paid' ? (
              <form action={`/api/admin/schools/${schoolId}/payments/invoices/${invoiceId}/void`} method="POST">
                <button type="submit" className="inline-flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50">
                  <Ban className="h-3.5 w-3.5" /> Void invoice
                </button>
              </form>
            ) : null}
          </div>
        </div>

        {/* Payment attempts */}
        <div className="rounded-xl border border-black/10 bg-white p-5">
          <h2 className="text-sm font-semibold text-zinc-900 mb-2">Payment attempts ({pays.length})</h2>
          {pays.length === 0 ? (
            <p className="text-xs text-zinc-500 italic">No payment attempts yet. The parent will be billed when they open the invoice.</p>
          ) : (
            <ul className="divide-y divide-zinc-100 text-sm">
              {pays.map((p) => (
                <li key={p.id} className="py-2 flex flex-wrap items-baseline gap-2 justify-between">
                  <div>
                    <span className="font-mono text-xs text-zinc-700">{p.stripe_payment_method_type ?? '—'}</span>
                    <span className="ml-2 text-zinc-900">${(p.amount_cents / 100).toFixed(2)}</span>
                    <PaymentStatusPill status={p.status} />
                    {p.failure_message ? (
                      <div className="text-xs text-red-700 mt-0.5">{p.failure_message}</div>
                    ) : null}
                  </div>
                  <div className="text-xs text-zinc-500">{new Date(p.created_at).toLocaleString()}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </main>
  );
}

// Autopay management panel — shows current state, lets the operator
// enable (picks a payment method) or disable. Also surfaces retry
// state when a previous autopay attempt failed.
function AutopayPanel({
  schoolId, invoiceId, enabled, currentMethodId, chargeOn, dueAt,
  retryAttemptCount, nextRetryAt, lastAttemptedAt, methods,
}: {
  schoolId: string;
  invoiceId: string;
  enabled: boolean;
  currentMethodId: string | null;
  chargeOn: string | null;
  dueAt: string;
  retryAttemptCount: number;
  nextRetryAt: string | null;
  lastAttemptedAt: string | null;
  methods: PaymentMethodOption[];
}) {
  if (enabled) {
    const current = methods.find((m) => m.id === currentMethodId);
    return (
      <div className="rounded-md border-2 border-emerald-200 bg-emerald-50/40 p-4 space-y-2">
        <div className="flex items-start gap-2">
          <Zap className="h-4 w-4 text-emerald-700 mt-0.5" />
          <div className="text-sm flex-1">
            <div className="font-semibold text-emerald-900">Autopay enabled</div>
            <div className="text-xs text-emerald-800 mt-0.5">
              Will charge {current ? <code className="font-mono">{(current.brand ?? current.type).toUpperCase()} ····{current.last4 ?? ''}</code> : 'the saved payment method'}
              {' '}on{' '}
              <strong>{new Date(chargeOn ?? dueAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</strong>.
            </div>
            {lastAttemptedAt ? (
              <div className="text-[11px] text-emerald-800 mt-1">
                Last attempt: {new Date(lastAttemptedAt).toLocaleString()} (attempt {retryAttemptCount})
                {nextRetryAt ? ` · next retry ${new Date(nextRetryAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : ''}
              </div>
            ) : null}
          </div>
        </div>
        <form action={`/api/admin/schools/${schoolId}/payments/invoices/${invoiceId}/autopay`} method="POST">
          <input type="hidden" name="action" value="disable" />
          <button type="submit" className="inline-flex items-center gap-1 rounded-md border border-emerald-300 bg-white px-3 py-1.5 text-xs font-semibold text-emerald-900 hover:bg-emerald-100">
            <ZapOff className="h-3 w-3" /> Disable autopay
          </button>
        </form>
      </div>
    );
  }

  if (methods.length === 0) {
    return (
      <div className="rounded-md border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-700">
        <div className="flex items-start gap-2">
          <Zap className="h-4 w-4 text-zinc-400 mt-0.5" />
          <div>
            <strong className="block">Autopay unavailable</strong>
            <p className="text-xs mt-0.5">
              The family doesn&rsquo;t have a saved payment method yet. They&rsquo;ll save one
              automatically the first time they pay an invoice with the
              &ldquo;Save for future autopay&rdquo; box checked.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-emerald-200 bg-emerald-50/30 p-4">
      <div className="flex items-start gap-2 mb-2">
        <Zap className="h-4 w-4 text-emerald-700 mt-0.5" />
        <div className="text-sm">
          <strong className="block text-emerald-900">Enable autopay</strong>
          <p className="text-xs text-emerald-800 mt-0.5">
            The system will charge the family automatically on the chosen date.
            If the charge fails (insufficient funds, expired card, etc.), it
            retries on the school&rsquo;s configured retry schedule.
          </p>
        </div>
      </div>
      <form action={`/api/admin/schools/${schoolId}/payments/invoices/${invoiceId}/autopay`} method="POST" className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="action" value="enable" />
        <label className="block text-xs">
          <span className="block font-medium text-zinc-700">Payment method</span>
          <select name="method_id" className="mt-0.5 rounded border border-zinc-300 px-2 py-1 text-sm">
            {methods.map((m) => (
              <option key={m.id} value={m.id}>
                {(m.brand ?? m.type).toUpperCase()} ····{m.last4 ?? ''}
                {m.is_default ? ' (default)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs">
          <span className="block font-medium text-zinc-700">Charge on</span>
          <input type="date" name="charge_on" defaultValue={new Date(dueAt).toISOString().slice(0, 10)}
            className="mt-0.5 rounded border border-zinc-300 px-2 py-1 text-sm" />
        </label>
        <button type="submit" className="inline-flex items-center gap-1 rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-800">
          <Zap className="h-3.5 w-3.5" /> Enable autopay
        </button>
      </form>
    </div>
  );
}

function DateField({ label, value }: { label: string; value: string }) {
  const d = new Date(value);
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="text-zinc-900">{d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { bg: string; fg: string; label: string }> = {
    draft:              { bg: 'bg-zinc-100', fg: 'text-zinc-700', label: 'Draft' },
    open:               { bg: 'bg-amber-100', fg: 'text-amber-800', label: 'Open' },
    paid:               { bg: 'bg-emerald-100', fg: 'text-emerald-800', label: 'Paid' },
    partially_paid:     { bg: 'bg-amber-100', fg: 'text-amber-800', label: 'Partial' },
    voided:             { bg: 'bg-zinc-100', fg: 'text-zinc-500', label: 'Voided' },
  };
  const cfg = map[status] ?? { bg: 'bg-zinc-100', fg: 'text-zinc-700', label: status };
  return (
    <span className={`rounded-full ${cfg.bg} px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${cfg.fg}`}>
      {cfg.label}
    </span>
  );
}

function PaymentStatusPill({ status }: { status: string }) {
  const map: Record<string, { bg: string; fg: string }> = {
    pending:    { bg: 'bg-zinc-100', fg: 'text-zinc-700' },
    processing: { bg: 'bg-amber-100', fg: 'text-amber-800' },
    succeeded:  { bg: 'bg-emerald-100', fg: 'text-emerald-800' },
    failed:     { bg: 'bg-red-100', fg: 'text-red-800' },
    refunded:   { bg: 'bg-red-100', fg: 'text-red-800' },
  };
  const cfg = map[status] ?? { bg: 'bg-zinc-100', fg: 'text-zinc-700' };
  return (
    <span className={`ml-2 rounded-full ${cfg.bg} px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${cfg.fg}`}>
      {status}
    </span>
  );
}

