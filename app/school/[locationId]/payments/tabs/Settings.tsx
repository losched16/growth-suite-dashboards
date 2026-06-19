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
  ghl_receipt_webhook_url: string | null;
  default_currency: string;
  // Loaded only to round-trip as hidden inputs — this compact embed
  // form doesn't edit them, but the shared config endpoint resets any
  // field absent from the POST, so we echo them back unchanged.
  autopay_days: number[];
  late_fee_amount_cents: number;
  late_fee_grace_days: number;
  // One-off invoice auto-bill window (NULL = off).
  autopay_oneoff_after_days: number | null;
}

export async function PaymentsHubSettings({
  schoolId, locationId, account,
}: { schoolId: string; locationId: string; account: Account | null }) {
  const { rows: cfgRows } = await query<ConfigRow>(
    `SELECT pass_card_fee, pass_ach_fee, processing_fee_label,
            card_enabled, ach_enabled, invoice_number_prefix,
            ghl_receipt_webhook_url, default_currency,
            autopay_days, late_fee_amount_cents, late_fee_grace_days,
            autopay_oneoff_after_days
       FROM school_payment_config WHERE school_id = $1`,
    [schoolId],
  );
  const cfg = cfgRows[0] ?? {
    pass_card_fee: true, pass_ach_fee: false,
    processing_fee_label: 'Processing fee',
    card_enabled: true, ach_enabled: true,
    invoice_number_prefix: 'INV',
    ghl_receipt_webhook_url: null,
    default_currency: 'usd',
    autopay_days: [1, 15], late_fee_amount_cents: 0, late_fee_grace_days: 3,
    autopay_oneoff_after_days: null,
  };

  const settingsReturnTo = `/school/${locationId}/payments?tab=settings`;

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
          <NeedsInfoPanel schoolId={schoolId} account={account} />
        ) : (
          <InProgressPanel schoolId={schoolId} locationId={locationId} account={account} />
        )}
        {account && !(account.charges_enabled && account.payouts_enabled) ? (
          <div className="mt-3 border-t border-slate-100 pt-3">
            <RefreshStatusButton schoolId={schoolId} returnTo={settingsReturnTo} />
          </div>
        ) : null}
      </section>

      {/* Billing config */}
      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <div className="flex items-baseline justify-between mb-3">
          <h3 className="text-base font-semibold text-slate-900">Billing configuration</h3>
        </div>
        <form action={`/api/admin/schools/${schoolId}/payments/config`} method="POST" className="space-y-3">
          <input type="hidden" name="return_to" value={settingsReturnTo} />
          {/* Round-trip fields this compact form doesn't edit so the
              shared config endpoint doesn't reset them to defaults. */}
          <input type="hidden" name="autopay_days" value={(cfg.autopay_days ?? [1, 15]).join(', ')} />
          <input type="hidden" name="late_fee_amount" value={((cfg.late_fee_amount_cents ?? 0) / 100).toFixed(2)} />
          <input type="hidden" name="late_fee_grace_days" value={String(cfg.late_fee_grace_days ?? 3)} />
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

          <SettingsGroup title="Currency"
            description="The currency parents are charged in. Applies to new payments — change this before sending invoices, not mid-cycle.">
            <Field label="Currency">
              <select name="default_currency" defaultValue={(cfg.default_currency ?? 'usd').toLowerCase()} className={inputCls}>
                <option value="usd">USD — US Dollar</option>
                <option value="cad">CAD — Canadian Dollar</option>
              </select>
            </Field>
          </SettingsGroup>

          <SettingsGroup
            title="Auto-bill one-off invoices"
            description="When on, a new one-off / incidental invoice automatically charges the family's saved card this many days after it's sent — but only if a card is on file (otherwise it stays manual-pay). Tuition installments follow their own schedule, and nothing charges until billing is live.">
            <input type="hidden" name="autopay_oneoff_present" value="1" />
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <Toggle
                name="autopay_oneoff_enabled"
                defaultChecked={cfg.autopay_oneoff_after_days != null}
                label="Auto-bill one-off invoices"
              />
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <span>after</span>
                <input
                  type="number"
                  name="autopay_oneoff_after_days"
                  min={0}
                  max={365}
                  defaultValue={cfg.autopay_oneoff_after_days ?? 5}
                  className="w-16 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-right tabular-nums focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-200"
                />
                <span>days</span>
              </label>
            </div>
          </SettingsGroup>

          <SettingsGroup
            title="Invoice & receipt emails via Growth Suite"
            description="Paste one Growth Suite workflow Inbound Webhook URL. We send an event when an invoice goes out and when a payment succeeds or fails — you design the actual emails in your own Growth Suite workflow. Leave blank to fall back to the built-in email.">
            <Field label="Growth Suite inbound webhook URL">
              <input type="text" name="ghl_receipt_webhook_url" defaultValue={cfg.ghl_receipt_webhook_url ?? ''} placeholder="https://services.leadconnectorhq.com/hooks/…" className={inputCls} />
            </Field>
            <div className="mt-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-[11px] text-slate-600 leading-relaxed">
              <div className="font-semibold text-slate-700 mb-1">How to wire it (one-time, ~3 min):</div>
              <ol className="list-decimal pl-4 space-y-0.5">
                <li>In Growth Suite → Automation → create a Workflow.</li>
                <li>Trigger: <span className="font-mono">Inbound Webhook</span> → copy the URL it generates → paste it above &amp; Save.</li>
                <li>Click <strong>Send test</strong> below so Growth Suite captures a sample payload.</li>
                <li>Add an <span className="font-mono">If/Else</span> on the <span className="font-mono">event</span> field, then a <span className="font-mono">Send Email</span> per branch.</li>
              </ol>
              <div className="mt-1.5">
                <span className="font-mono">event</span> is <span className="font-mono">invoice.sent</span> (use <span className="font-mono">pay_url</span> + <span className="font-mono">due_date</span>),{' '}
                <span className="font-mono">payment.succeeded</span> (<span className="font-mono">receipt_url</span>), or <span className="font-mono">payment.failed</span> (<span className="font-mono">failure_reason</span>).
              </div>
              <div className="mt-1.5 font-mono text-[10px] text-slate-500">
                email · first_name · last_name · amount_formatted · invoice_number · invoice_title · invoice_description · due_date · pay_url · school_name
              </div>
            </div>
          </SettingsGroup>

          <button type="submit" className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
            Save settings
          </button>
        </form>

        {cfg.ghl_receipt_webhook_url ? (
          <form action={`/api/admin/schools/${schoolId}/payments/test-receipt-webhook`} method="POST" className="mt-3">
            <input type="hidden" name="return_to" value={settingsReturnTo} />
            <button type="submit" className="rounded-md border border-emerald-300 bg-white px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50">
              Send test to Growth Suite
            </button>
            <span className="ml-2 text-[11px] text-slate-500">Fires a sample <span className="font-mono">invoice.sent</span> so you can confirm the workflow runs.</span>
          </form>
        ) : null}
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

// On-demand re-pull of Stripe status. After the operator finishes (or
// continues) onboarding in the Stripe tab, clicking this writes the
// fresh charges_enabled / payouts_enabled to our DB — so they don't
// have to wait on (or depend on) the account.updated webhook before
// the invoice pay page unlocks.
function RefreshStatusButton({ schoolId, returnTo }: { schoolId: string; returnTo: string }) {
  return (
    <form action={`/api/admin/schools/${schoolId}/payments/refresh-account`} method="POST">
      <input type="hidden" name="return_to" value={returnTo} />
      <button type="submit" className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
        Refresh Stripe status
      </button>
      <span className="ml-2 text-[11px] text-slate-500">Click after you finish Stripe onboarding to sync &amp; unlock payments.</span>
    </form>
  );
}

function ConnectPrompt({ schoolId, locationId }: { schoolId: string; locationId?: string }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-700">
        Not connected yet. Pick the path that fits your school:
      </p>

      {/* Path 1: brand-new Stripe account */}
      <div className="rounded-md border border-slate-200 bg-slate-50/50 p-3">
        <div className="text-sm font-semibold text-slate-900 mb-1">
          📦 Set up a new Stripe account
        </div>
        <p className="text-xs text-slate-600 mb-2">
          For schools that have never used Stripe. Walks through KYC, bank account, and identity verification in one flow. Takes about 5 minutes.
        </p>
        {/* target="_blank" — Stripe refuses to load in iframes. New-tab pattern preserves the GHL session. */}
        <form action={`/api/admin/schools/${schoolId}/payments/connect`} method="POST" target="_blank" rel="noopener noreferrer">
          {locationId ? <input type="hidden" name="return_to" value={`/school/${locationId}/payments`} /> : null}
          <button type="submit" className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700">
            Create a new Stripe account
          </button>
        </form>
      </div>

      {/* Path 2: connect existing Stripe account */}
      <div className="rounded-md border border-slate-200 bg-slate-50/50 p-3">
        <div className="text-sm font-semibold text-slate-900 mb-1">
          🔗 I already have a Stripe account
        </div>
        <p className="text-xs text-slate-600 mb-2">
          For schools that already accept payments through Stripe. Sign in with your existing Stripe credentials and authorize this platform to issue invoices on your account. Bank account + payment methods + tax settings stay exactly as they are. ~30 seconds.
        </p>
        <form action={`/api/admin/schools/${schoolId}/payments/connect-oauth/start`} method="POST" target="_blank" rel="noopener noreferrer">
          <button type="submit" className="inline-flex items-center gap-1.5 rounded-md border-2 border-blue-600 bg-white px-3 py-1.5 text-sm font-semibold text-blue-700 hover:bg-blue-50">
            Connect existing Stripe account
          </button>
        </form>
      </div>

      <p className="text-[11px] text-slate-500">
        Both paths open Stripe in a new tab. The school keeps full ownership of its Stripe account either way — funds settle directly to their bank, never to us.
      </p>
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

function NeedsInfoPanel({
  schoolId, account,
}: { schoolId: string; account: Account }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-amber-700">
        <AlertTriangle className="h-4 w-4" />
        <span className="font-semibold">Stripe needs additional info</span>
      </div>
      <p className="text-sm text-slate-700">
        Stripe has flagged the following items for review:
      </p>
      {account.requirements_currently_due && account.requirements_currently_due.length > 0 ? (
        <ul className="list-disc pl-5 text-xs text-slate-600">
          {account.requirements_currently_due.map((r, i) => <li key={i}><code>{r}</code></li>)}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={`https://dashboard.stripe.com/${account.stripe_account_id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-md border border-amber-400 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-50"
        >
          Resolve in Stripe <ExternalLink className="h-3 w-3" />
        </a>
      </div>
      <SwitchToExistingPrompt schoolId={schoolId} currentAccountId={account.stripe_account_id} />
    </div>
  );
}

function InProgressPanel({
  schoolId, locationId, account,
}: { schoolId: string; locationId?: string; account: Account }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-700">
        Stripe onboarding was started but not yet finished. Pick up where the school left off:
      </p>
      {/* target="_blank" — Stripe Connect refuses to load inside the iframe; see ConnectPrompt above. */}
      <form action={`/api/admin/schools/${schoolId}/payments/connect`} method="POST" target="_blank" rel="noopener noreferrer">
        {locationId ? <input type="hidden" name="return_to" value={`/school/${locationId}/payments`} /> : null}
        <button type="submit" className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700">
          Continue Stripe onboarding
        </button>
      </form>
      <p className="text-[11px] text-slate-500">Opens Stripe in a new tab.</p>
      <SwitchToExistingPrompt schoolId={schoolId} currentAccountId={account.stripe_account_id} />
    </div>
  );
}

// Reusable "actually, I already have a Stripe account I'd like to use
// instead" prompt. Shown on both InProgressPanel and NeedsInfoPanel —
// covers the case where a school clicked "Create new" by mistake and
// now wants to switch to OAuth-connecting their existing account.
//
// Safe: the OAuth callback INSERTs ON CONFLICT (school_id) DO UPDATE,
// so authorizing a different stripe_user_id cleanly replaces the
// half-completed row. No funds / invoices live on the abandoned
// in-progress account, so there's nothing to migrate.
function SwitchToExistingPrompt({
  schoolId, currentAccountId,
}: { schoolId: string; currentAccountId: string }) {
  return (
    <details className="rounded-md border border-slate-200 bg-slate-50/60 p-3 group">
      <summary className="cursor-pointer text-xs font-semibold text-slate-700 list-none flex items-center gap-1">
        <span className="text-slate-400 group-open:rotate-90 inline-block transition-transform">▸</span>
        I&apos;d rather connect an existing Stripe account
      </summary>
      <div className="mt-2 space-y-2">
        <p className="text-xs text-slate-600">
          Already have a Stripe account you use elsewhere? Sign in with your existing credentials below
          and we&apos;ll switch this school over. Bank account, tax settings, and payment methods stay
          exactly as they are on your existing account — we just authorize this platform to issue
          invoices on it.
        </p>
        <p className="text-[11px] text-slate-500">
          This will replace the in-progress connection (<code className="font-mono">{currentAccountId}</code>),
          which has no live invoices yet. Takes about 30 seconds.
        </p>
        <form action={`/api/admin/schools/${schoolId}/payments/connect-oauth/start`} method="POST" target="_blank" rel="noopener noreferrer">
          <button type="submit" className="inline-flex items-center gap-1.5 rounded-md border-2 border-blue-600 bg-white px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-50">
            Connect existing Stripe account
          </button>
        </form>
      </div>
    </details>
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
