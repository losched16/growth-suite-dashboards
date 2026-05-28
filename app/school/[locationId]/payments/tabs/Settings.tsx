// Settings tab — Stripe Connect status + billing-config form +
// tuition grids + payment plans. Keeps the heavy operator UI behind a
// link to /admin (where the full editor lives) for now — embed view
// shows status + the top-3 most-frequently-changed knobs.

import Link from 'next/link';
import { CreditCard, ExternalLink, CheckCircle2, AlertTriangle } from 'lucide-react';
import { query } from '@/lib/db';

interface Account {
  stripe_account_id: string;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  requirements_currently_due: string[] | null;
  last_synced_at: Date | null;
}

interface ConfigRow {
  pass_card_fee: boolean;
  pass_ach_fee: boolean;
  processing_fee_label: string;
  card_enabled: boolean;
  ach_enabled: boolean;
  invoice_number_prefix: string;
}

export async function PaymentsHubSettings({
  schoolId, locationId, account,
}: { schoolId: string; locationId: string; account: Account | null }) {
  const { rows: cfgRows } = await query<ConfigRow>(
    `SELECT pass_card_fee, pass_ach_fee, processing_fee_label,
            card_enabled, ach_enabled, invoice_number_prefix
       FROM school_payment_config WHERE school_id = $1`,
    [schoolId],
  );
  const cfg = cfgRows[0] ?? {
    pass_card_fee: true, pass_ach_fee: false,
    processing_fee_label: 'Processing fee',
    card_enabled: true, ach_enabled: true,
    invoice_number_prefix: 'INV',
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">Settings</h2>
        <p className="text-sm text-slate-500">
          Payment provider, fee passthrough rules, and how invoice numbers are generated.
        </p>
      </div>

      {/* Stripe Connect card */}
      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <div className="flex items-center gap-2 mb-3">
          <CreditCard className="h-5 w-5 text-blue-600" />
          <h3 className="text-base font-semibold text-slate-900">Stripe Connect</h3>
        </div>

        {!account ? (
          <ConnectPrompt schoolId={schoolId} locationId={locationId} />
        ) : account.charges_enabled && account.payouts_enabled ? (
          <LivePanel account={account} />
        ) : account.details_submitted ? (
          <NeedsInfoPanel account={account} />
        ) : (
          <InProgressPanel schoolId={schoolId} locationId={locationId} />
        )}
      </section>

      {/* Billing config */}
      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <div className="flex items-baseline justify-between mb-3">
          <h3 className="text-base font-semibold text-slate-900">Billing configuration</h3>
        </div>
        <form action={`/api/admin/schools/${schoolId}/payments/config`} method="POST" className="space-y-3">
          <SettingsGroup title="Payment methods accepted">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <Toggle name="card_enabled" defaultChecked={cfg.card_enabled} label="Credit / debit cards" />
              <Toggle name="ach_enabled"  defaultChecked={cfg.ach_enabled}  label="ACH bank transfer" />
            </div>
          </SettingsGroup>

          <SettingsGroup title="Fee pass-through"
            description="When enabled, the parent sees the processing fee added to their total.">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <Toggle name="pass_card_fee" defaultChecked={cfg.pass_card_fee} label="Pass card fee to parent (2.9% + 30¢)" />
              <Toggle name="pass_ach_fee"  defaultChecked={cfg.pass_ach_fee}  label="Pass ACH fee to parent (0.8%, max $5)" />
            </div>
            <Field className="mt-2" label="Fee label parents see">
              <input type="text" name="processing_fee_label" defaultValue={cfg.processing_fee_label} className={inputCls} />
            </Field>
          </SettingsGroup>

          <SettingsGroup title="Invoice numbering">
            <Field label="Invoice prefix">
              <input type="text" name="invoice_number_prefix" defaultValue={cfg.invoice_number_prefix} className={inputCls} />
            </Field>
          </SettingsGroup>

          <button type="submit" className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
            Save settings
          </button>
        </form>
      </section>

      {/* Quick links into school-side editors (stay inside the iframe) */}
      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <h3 className="text-base font-semibold text-slate-900 mb-2">Other places to edit</h3>
        <p className="text-xs text-slate-500 mb-3">
          Need to change tuition prices, payment plans, discounts, or enrollments?
          Each lives in its own tab so the form stays small.
        </p>
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
          <li>
            <Link href={`/school/${locationId}/payments?tab=plans`} className="text-blue-600 hover:underline">
              Tuition plans &amp; enrollments →
            </Link>
          </li>
          <li>
            <Link href={`/school/${locationId}/payments?tab=catalog`} className="text-blue-600 hover:underline">
              Product catalog →
            </Link>
          </li>
          <li>
            <Link href={`/school/${locationId}/payments?tab=discounts`} className="text-blue-600 hover:underline">
              Discount policies →
            </Link>
          </li>
          <li>
            <Link href={`/school/${locationId}/payments?tab=invoices`} className="text-blue-600 hover:underline">
              Invoices →
            </Link>
          </li>
        </ul>
      </section>
      {void locationId}
    </div>
  );
}

function ConnectPrompt({ schoolId, locationId }: { schoolId: string; locationId?: string }) {
  return (
    <div>
      <p className="text-sm text-slate-700 mb-3">
        Not connected yet. Connect a Stripe account to start accepting parent payments. The school keeps full ownership of its Stripe account — funds settle directly to their bank.
      </p>
      <form action={`/api/admin/schools/${schoolId}/payments/connect`} method="POST">
        {locationId ? <input type="hidden" name="return_to" value={`/school/${locationId}/payments`} /> : null}
        <button type="submit" className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
          Connect with Stripe
        </button>
      </form>
    </div>
  );
}

function LivePanel({ account }: { account: Account }) {
  return (
    <div className="space-y-2 text-sm">
      <div className="flex items-center gap-2 text-emerald-700">
        <CheckCircle2 className="h-4 w-4" />
        <span className="font-semibold">Connected & accepting payments</span>
      </div>
      <div className="text-xs text-slate-600">
        Stripe account: <span className="font-mono">{account.stripe_account_id}</span>
      </div>
      <div className="flex items-center gap-3 mt-2">
        <a
          href={`https://dashboard.stripe.com/${account.stripe_account_id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
        >
          Open Stripe dashboard <ExternalLink className="h-3 w-3" />
        </a>
        {account.last_synced_at ? (
          <span className="text-[11px] text-slate-500">
            Last synced {new Date(account.last_synced_at).toLocaleString()}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function NeedsInfoPanel({ account }: { account: Account }) {
  return (
    <div>
      <div className="flex items-center gap-2 text-amber-700 mb-2">
        <AlertTriangle className="h-4 w-4" />
        <span className="font-semibold">Stripe needs additional info</span>
      </div>
      <p className="text-sm text-slate-700 mb-2">
        Stripe has flagged the following items for review:
      </p>
      {account.requirements_currently_due && account.requirements_currently_due.length > 0 ? (
        <ul className="list-disc pl-5 text-xs text-slate-600 mb-3">
          {account.requirements_currently_due.map((r, i) => <li key={i}><code>{r}</code></li>)}
        </ul>
      ) : null}
      <a
        href={`https://dashboard.stripe.com/${account.stripe_account_id}`}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 rounded-md border border-amber-400 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-50"
      >
        Resolve in Stripe <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  );
}

function InProgressPanel({ schoolId, locationId }: { schoolId: string; locationId?: string }) {
  return (
    <div>
      <p className="text-sm text-slate-700 mb-2">
        Stripe onboarding started but not yet finished. Continue where the school left off:
      </p>
      <form action={`/api/admin/schools/${schoolId}/payments/connect`} method="POST">
        {locationId ? <input type="hidden" name="return_to" value={`/school/${locationId}/payments`} /> : null}
        <button type="submit" className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
          Continue Stripe onboarding
        </button>
      </form>
    </div>
  );
}

// ─── small UI helpers ────────────────────────────────────────────

function SettingsGroup({
  title, description, children,
}: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-slate-100 pt-3 first:border-t-0 first:pt-0">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-600">{title}</h4>
      {description ? <p className="text-[11px] text-slate-500 mt-0.5">{description}</p> : null}
      <div className="mt-2">{children}</div>
    </div>
  );
}

function Field({
  label, children, className,
}: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block ${className ?? ''}`}>
      <span className="text-[11px] font-medium uppercase tracking-wide text-slate-600">{label}</span>
      <div className="mt-0.5">{children}</div>
    </label>
  );
}

function Toggle({
  name, defaultChecked, label,
}: { name: string; defaultChecked: boolean; label: string }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" name={name} value="1" defaultChecked={defaultChecked}
        className="h-4 w-4 rounded border-slate-300" />
      <span>{label}</span>
    </label>
  );
}

const inputCls =
  'block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-200';
