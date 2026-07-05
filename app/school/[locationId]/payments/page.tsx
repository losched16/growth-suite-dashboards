// /school/[locationId]/payments — GHL-embedded payments hub.
//
// Designed to live inside a GHL "Custom Menu Link" iframe. Replaces
// GHL's native /payments page entirely. Visual language mirrors GHL:
// light gray background, white cards, blue primary actions, horizontal
// sub-nav across the top.
//
// Sub-nav tabs (URL param `tab=`):
//   overview  (default) — KPIs + at-a-glance
//   invoices            — invoice list with filters + create CTA
//   plans               — family tuition enrollments
//   discounts           — discount policies
//   forms               — link to form editor (heavier UI, separate)
//   settings            — Stripe Connect + billing config + tuition grids
//
// Auth: gated by the existing school session cookie (set via GHL embed
// token). The proxy keeps this route locked to the school's location.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { query } from '@/lib/db';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { loadPaymentAccount } from '@/lib/stripe/connect-onboarding';
import { PaymentsHubOverview } from './tabs/Overview';
import { PaymentsHubInvoices } from './tabs/Invoices';
import { PaymentsHubPlans } from './tabs/Plans';
import { PaymentsHubGrids } from './tabs/Grids';
import { PaymentsHubDiscounts } from './tabs/Discounts';
import { PaymentsHubSettings } from './tabs/Settings';
import { PaymentsHubCatalog } from './tabs/Catalog';
import { PaymentsHubDocuments } from './tabs/Documents';
import { PaymentsHubFinancialAid } from './tabs/FinancialAid';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Params = Promise<{ locationId: string }>;
type SearchParams = Promise<{ tab?: string; msg?: string; err?: string; edit_template?: string; q?: string; status?: string }>;

const TABS = [
  { value: 'overview',  label: 'Overview' },
  { value: 'invoices',  label: 'Invoices' },
  { value: 'plans',     label: 'Tuition Plans' },
  { value: 'grids',     label: 'Grids' },
  { value: 'catalog',   label: 'Catalog' },
  { value: 'discounts', label: 'Discounts' },
  { value: 'financial-aid', label: 'Financial Aid' },
  { value: 'documents', label: 'Important Docs' },
  { value: 'settings',  label: 'Settings' },
] as const;

export default async function PaymentsHubPage({
  params, searchParams,
}: { params: Params; searchParams: SearchParams }) {
  const { locationId } = await params;
  const sp = await searchParams;
  const tab = (sp.tab && TABS.some((t) => t.value === sp.tab)) ? sp.tab : 'overview';

  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();

  // Always resolve the Stripe Connect status so the header pill stays
  // visible across tabs.
  const account = await loadPaymentAccount(school.id);
  const stripeStatus =
    account?.charges_enabled ? 'live'
    : account?.details_submitted ? 'needs_info'
    : account ? 'in_progress'
    : 'not_connected';

  // Dry-run mode: migration 046 added billing_active. While false, all
  // new invoices land in 'draft' status, parents see nothing, autopay
  // is paused. The banner below makes this state obvious and gives the
  // operator a one-click Go-Live action.
  const { rows: cfgRows } = await query<{ billing_active: boolean; draft_count: number }>(
    `SELECT
       COALESCE(spc.billing_active, false) AS billing_active,
       (SELECT COUNT(*)::int FROM invoices i
         WHERE i.school_id = $1
           AND i.source = 'tuition_plan'
           AND i.status = 'draft') AS draft_count
       FROM school_payment_config spc
      WHERE spc.school_id = $1`,
    [school.id],
  );
  const billingActive = cfgRows[0]?.billing_active ?? false;
  const draftCount = cfgRows[0]?.draft_count ?? 0;

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <div className="bg-white border-b border-slate-200">
        <div className="px-6 pt-5 pb-0">
          <div className="flex items-baseline justify-between gap-4 flex-wrap">
            <div className="flex items-baseline gap-3">
              <h1 className="text-2xl font-semibold text-slate-900">Payments</h1>
              <StripePill status={stripeStatus} />
            </div>
            <div className="flex items-center gap-2">
              {tab === 'invoices' ? (
                <Link
                  href={`/school/${locationId}/payments?tab=settings`}
                  className="text-xs text-slate-600 hover:text-slate-900 underline"
                >
                  Settings →
                </Link>
              ) : null}
            </div>
          </div>

          {/* Sub-nav */}
          <nav className="mt-4 -mb-px flex items-center gap-1 overflow-x-auto">
            {TABS.map((t) => {
              const active = t.value === tab;
              return (
                <Link
                  key={t.value}
                  href={`/school/${locationId}/payments?tab=${t.value}`}
                  className={`px-3 py-2 text-sm border-b-2 -mb-px whitespace-nowrap ${
                    active
                      ? 'border-blue-600 text-blue-700 font-semibold'
                      : 'border-transparent text-slate-600 hover:text-slate-900 hover:border-slate-300'
                  }`}
                >
                  {t.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </div>

      {/* Toast row */}
      {sp.msg || sp.err ? (
        <div className="px-6 pt-4">
          {sp.msg ? (
            <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{sp.msg}</div>
          ) : null}
          {sp.err ? (
            <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{sp.err}</div>
          ) : null}
        </div>
      ) : null}

      {/* Dry-run banner — when billing_active=false. Sticky-prominent so
          the operator never forgets they're not actually charging anyone
          yet, with a Go-Live form inline. */}
      {!billingActive ? (
        <DryRunBanner
          locationId={locationId}
          draftCount={draftCount}
        />
      ) : null}

      {/* Tab content */}
      <div className="px-6 py-5">
        {tab === 'overview'  ? <PaymentsHubOverview  schoolId={school.id} locationId={locationId} /> : null}
        {tab === 'invoices'  ? <PaymentsHubInvoices  schoolId={school.id} locationId={locationId} q={sp.q ?? ''} statusFilter={sp.status ?? ''} /> : null}
        {tab === 'plans'     ? <PaymentsHubPlans     schoolId={school.id} locationId={locationId} editTemplateId={sp.edit_template ?? null} familySearch={sp.q ?? ''} /> : null}
        {tab === 'grids'     ? <PaymentsHubGrids     schoolId={school.id} locationId={locationId} /> : null}
        {tab === 'catalog'   ? <PaymentsHubCatalog   schoolId={school.id} locationId={locationId} /> : null}
        {tab === 'discounts' ? <PaymentsHubDiscounts schoolId={school.id} locationId={locationId} /> : null}
        {tab === 'financial-aid' ? <PaymentsHubFinancialAid schoolId={school.id} locationId={locationId} schoolName={school.name} /> : null}
        {tab === 'documents' ? <PaymentsHubDocuments schoolId={school.id} locationId={locationId} /> : null}
        {tab === 'settings'  ? <PaymentsHubSettings  schoolId={school.id} locationId={locationId} account={account} /> : null}
      </div>
    </div>
  );
}

// Dry-run banner shown at the top of the Payments hub when the school
// hasn't flipped billing_active=true yet. Explains the implications and
// gives the operator a confirm-phrase-gated "Go live" form to flip the
// switch. We require the operator to type GO_LIVE so it can't be
// accidentally clicked while clicking around.
function DryRunBanner({
  locationId, draftCount,
}: { locationId: string; draftCount: number }) {
  const returnTo = `/school/${locationId}/payments`;
  return (
    <div className="px-6 pt-4">
      <div className="rounded-lg border-2 border-amber-300 bg-amber-50 p-4">
        <div className="flex items-start gap-3">
          <div className="text-2xl leading-none mt-0.5">⚠️</div>
          <div className="flex-1 min-w-0">
            <div className="text-base font-bold text-amber-900">Dry-run mode — billing is paused</div>
            <p className="mt-1 text-sm text-amber-900">
              No real parent charges happen yet. New invoices generate as <strong>drafts</strong>{' '}
              that only you can see — parents don&rsquo;t get notification emails, drafts don&rsquo;t appear
              in their portal, autopay is paused.
            </p>
            <p className="mt-1 text-sm text-amber-900">
              Use this time to verify tuition amounts, plan schedules, and discount rules against your
              actual family data. When everything looks right, click <strong>Go live</strong> to flip the
              switch — all {draftCount > 0 ? <><strong>{draftCount}</strong> existing draft invoice{draftCount === 1 ? '' : 's'}</> : 'future invoices'} will become visible to parents and the autopay rhythm starts.
            </p>

            <details className="mt-3 group">
              <summary className="cursor-pointer list-none inline-flex items-center gap-1.5 rounded-md bg-amber-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-amber-800">
                Ready to go live — show me the confirmation step
              </summary>
              <form
                action="/api/school/billing/go-live"
                method="POST"
                className="mt-3 rounded-md border border-amber-200 bg-white p-3 space-y-2"
              >
                <input type="hidden" name="return_to" value={returnTo} />
                <p className="text-xs text-slate-700">
                  Type <code className="font-mono bg-slate-100 px-1.5 py-0.5 rounded">GO_LIVE</code> to
                  confirm. This action is final — once parents see real invoices, they expect them to
                  represent real charges. You can still pause individual enrollments or void specific
                  invoices afterward, but the &ldquo;dry-run&rdquo; gate doesn&rsquo;t come back.
                </p>
                <input
                  type="text"
                  name="confirm"
                  required
                  pattern="GO_LIVE"
                  placeholder="GO_LIVE"
                  autoComplete="off"
                  className="block w-full max-w-xs rounded border border-slate-300 bg-white px-3 py-2 text-sm font-mono focus:border-amber-600 focus:outline-none focus:ring-1 focus:ring-amber-200"
                />
                <button
                  type="submit"
                  className="inline-flex items-center gap-1.5 rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800"
                >
                  Go live — start billing parents
                </button>
              </form>
            </details>
          </div>
        </div>
      </div>
    </div>
  );
}

function StripePill({ status }: { status: 'live' | 'needs_info' | 'in_progress' | 'not_connected' }) {
  const cfg = {
    live:          { bg: 'bg-emerald-100', fg: 'text-emerald-800',  label: 'Stripe: Live'      },
    needs_info:    { bg: 'bg-amber-100',   fg: 'text-amber-800',    label: 'Stripe: Needs info'},
    in_progress:   { bg: 'bg-blue-100',    fg: 'text-blue-800',     label: 'Stripe: Onboarding'},
    not_connected: { bg: 'bg-slate-100',   fg: 'text-slate-600',    label: 'Stripe: Not connected'},
  }[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full ${cfg.bg} px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${cfg.fg}`}>
      {cfg.label}
    </span>
  );
}

void query; // re-export for tabs that import lazily from this file
