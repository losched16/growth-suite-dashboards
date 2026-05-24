// /admin/[schoolId]/payments/purchases/[purchaseId] — single-purchase
// drilldown with refund button.

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { Mail, Phone, ExternalLink, RefreshCw } from 'lucide-react';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { query } from '@/lib/db';
import { RefundForm } from './RefundForm';

export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string; purchaseId: string }>;
type SearchParams = Promise<{ msg?: string; err?: string }>;

interface PurchaseRow {
  id: string;
  product_id: string;
  product_name: string;
  product_type: string;
  family_id: string | null;
  family_display_name: string | null;
  student_id: string | null;
  student_display_name: string | null;
  purchaser_email: string | null;
  purchaser_name: string | null;
  purchaser_phone: string | null;
  ghl_contact_id: string | null;
  quantity: number;
  unit_amount_cents: number;
  total_amount_cents: number;
  refunded_amount_cents: number;
  refund_reason: string | null;
  refunded_at: string | null;
  status: string;
  source: string;
  source_ref: string | null;
  stripe_payment_intent_id: string | null;
  stripe_subscription_id: string | null;
  stripe_charge_id: string | null;
  ip_address: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

function fmtCents(c: number): string {
  return `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDateTime(s: string): string {
  return new Date(s).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export default async function PurchaseDetail({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const ck = await cookies();
  if (!verifySessionToken(ck.get(SESSION_COOKIE)?.value)) redirect('/login');
  const { schoolId, purchaseId } = await params;
  const sp = await searchParams;

  const { rows } = await query<PurchaseRow>(
    `SELECT pp.*,
            sp.name AS product_name, sp.product_type,
            f.display_name AS family_display_name,
            (CASE WHEN s.id IS NOT NULL THEN COALESCE(NULLIF(s.preferred_name, ''), s.first_name) || ' ' || s.last_name ELSE NULL END) AS student_display_name
       FROM product_purchases pp
       JOIN school_products sp ON sp.id = pp.product_id
       LEFT JOIN families f ON f.id = pp.family_id
       LEFT JOIN students s ON s.id = pp.student_id
      WHERE pp.id = $1 AND pp.school_id = $2`,
    [purchaseId, schoolId],
  );
  if (rows.length === 0) notFound();
  const p = rows[0];

  // CRM deep-link for GHL contact if we have one
  const crmBase = process.env.CRM_APP_BASE || 'https://app.mygrowthsuite.com';
  const { rows: schoolRow } = await query<{ ghl_location_id: string | null }>(
    `SELECT ghl_location_id FROM schools WHERE id = $1`, [schoolId],
  );
  const ghlUrl = p.ghl_contact_id && schoolRow[0]?.ghl_location_id
    ? `${crmBase}/v2/location/${schoolRow[0].ghl_location_id}/contacts/detail/${p.ghl_contact_id}`
    : null;

  const refundable = p.status === 'succeeded' && p.refunded_amount_cents < p.total_amount_cents;
  const remainingRefundable = p.total_amount_cents - p.refunded_amount_cents;

  return (
    <div className="space-y-5 max-w-3xl">
      <div>
        <Link href={`/admin/${schoolId}/payments/purchases`} className="text-xs text-gray-500 hover:text-gray-700">
          ← Back to purchases
        </Link>
      </div>

      {sp.msg ? <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{sp.msg}</div> : null}
      {sp.err ? <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{sp.err}</div> : null}

      <header className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">{p.product_name}</h1>
          <p className="mt-1 text-sm text-gray-600">
            <Link href={`/admin/${schoolId}/payments/products/${p.product_id}`} className="text-emerald-700 hover:underline">
              Edit product →
            </Link>
          </p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-semibold text-gray-900">{fmtCents(p.total_amount_cents)}</div>
          <div className="text-xs text-gray-500">
            {p.quantity} × {fmtCents(p.unit_amount_cents)}
          </div>
          <StatusBadge status={p.status} />
        </div>
      </header>

      {/* Buyer */}
      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Buyer</h2>
        <div className="space-y-1 text-sm">
          <div className="font-medium text-gray-900">{p.purchaser_name ?? '(no name on file)'}</div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {p.purchaser_email ? (
              <a href={`mailto:${p.purchaser_email}`} className="inline-flex items-center gap-1 text-blue-600 hover:underline">
                <Mail className="h-3 w-3" /> {p.purchaser_email}
              </a>
            ) : null}
            {p.purchaser_phone ? (
              <a href={`tel:${p.purchaser_phone}`} className="inline-flex items-center gap-1 text-blue-600 hover:underline">
                <Phone className="h-3 w-3" /> {p.purchaser_phone}
              </a>
            ) : null}
          </div>
          {ghlUrl ? (
            <a href={ghlUrl} target="_top" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-emerald-700 hover:underline">
              Open contact in Growth Suite <ExternalLink className="h-3 w-3" />
            </a>
          ) : null}
          {p.family_display_name ? (
            <div className="text-xs text-gray-600">
              <span className="font-medium">Linked family:</span> {p.family_display_name}
            </div>
          ) : null}
          {p.student_display_name ? (
            <div className="text-xs text-gray-600">
              <span className="font-medium">Student:</span> {p.student_display_name}
            </div>
          ) : null}
        </div>
      </section>

      {/* Refund */}
      {refundable ? (
        <section className="rounded-lg border border-amber-200 bg-amber-50/40 p-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-amber-700 mb-2">
            Refund
          </h2>
          <p className="text-xs text-amber-900 mb-3">
            Up to {fmtCents(remainingRefundable)} refundable.
            {p.stripe_subscription_id ? ' Subscription stays active — cancel separately if needed.' : ''}
          </p>
          <RefundForm
            schoolId={schoolId}
            purchaseId={p.id}
            maxRefundCents={remainingRefundable}
          />
        </section>
      ) : p.refunded_amount_cents > 0 ? (
        <section className="rounded-lg border border-blue-200 bg-blue-50/40 p-4 text-sm">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-blue-700 mb-2">Refunded</h2>
          <div>
            {fmtCents(p.refunded_amount_cents)} refunded on{' '}
            {p.refunded_at ? fmtDateTime(p.refunded_at) : '—'}
            {p.refund_reason ? <span className="text-blue-700"> · {p.refund_reason}</span> : null}
          </div>
        </section>
      ) : null}

      {/* Stripe + provenance */}
      <section className="rounded-lg border border-gray-200 bg-white p-4 text-xs">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Technical</h2>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
          <Row label="Purchase ID">{p.id}</Row>
          <Row label="Source">{p.source}{p.source_ref ? ` (${p.source_ref})` : ''}</Row>
          <Row label="Created">{fmtDateTime(p.created_at)}</Row>
          <Row label="Stripe PaymentIntent">{p.stripe_payment_intent_id ?? '—'}</Row>
          <Row label="Stripe Charge">{p.stripe_charge_id ?? '—'}</Row>
          <Row label="Stripe Subscription">{p.stripe_subscription_id ?? '—'}</Row>
          <Row label="GHL Contact ID">{p.ghl_contact_id ?? '—'}</Row>
          <Row label="IP Address">{p.ip_address ?? '—'}</Row>
        </dl>
      </section>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls = {
    succeeded: 'bg-emerald-100 text-emerald-800',
    pending:   'bg-amber-100 text-amber-800',
    failed:    'bg-rose-100 text-rose-800',
    canceled:  'bg-slate-100 text-slate-700',
    refunded:  'bg-blue-100 text-blue-800',
  }[status] ?? 'bg-slate-100 text-slate-700';
  return (
    <div className="mt-1">
      <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cls}`}>
        {status}
      </span>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-gray-500">{label}</dt>
      <dd className="text-gray-900 font-mono text-[11px] break-all">{children}</dd>
    </>
  );
}
