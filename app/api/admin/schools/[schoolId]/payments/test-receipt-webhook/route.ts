// POST /api/admin/schools/{schoolId}/payments/test-receipt-webhook
//
// Fires a sample payment.succeeded payload at the school's configured
// GHL inbound-webhook URL so the operator can confirm the workflow runs
// and capture the field shape in GHL before a real payment happens.
//
// Payload mirrors lib/billing/ghl-receipt.ts EXACTLY (keep in sync) so
// what GHL captures here matches what real payments send.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { authorizeOperatorOrSchool } from '@/lib/auth/dual';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string }>;

function safeReturn(returnTo: string | null, fallback: string): string {
  if (returnTo && /^\/(admin|school)\/[A-Za-z0-9_-]+(\/[^?#]*)?(\?[^#]*)?$/.test(returnTo)) return returnTo;
  return fallback;
}

function back(request: NextRequest, schoolId: string, q: { msg?: string; err?: string }, returnTo: string | null = null) {
  const url = request.nextUrl.clone();
  const target = safeReturn(returnTo, `/admin/${schoolId}/payments`);
  const [path, qs] = target.split('?');
  url.pathname = path;
  url.search = qs ? `?${qs}` : '';
  if (q.msg) url.searchParams.set('msg', q.msg);
  if (q.err) url.searchParams.set('err', q.err);
  return NextResponse.redirect(url, 303);
}

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId } = await params;
  const _auth = await authorizeOperatorOrSchool(schoolId);
  if (!_auth.ok) return _auth.response;
  const fd = await request.formData().catch(() => null);
  const returnTo = fd ? (String(fd.get('return_to') ?? '').trim() || null) : null;

  const { rows } = await query<{ url: string | null; name: string | null }>(
    `SELECT cfg.ghl_receipt_webhook_url AS url, s.name
       FROM schools s
       LEFT JOIN school_payment_config cfg ON cfg.school_id = s.id
      WHERE s.id = $1`,
    [schoolId],
  );
  const row = rows[0];
  if (!row?.url) {
    return back(request, schoolId, { err: 'No Growth Suite webhook URL configured. Save one first.' }, returnTo);
  }

  const today = new Date();
  const payload = {
    event: 'invoice.sent',
    contact_id: '',
    email: 'test-recipient@example.com',
    phone: '',
    first_name: 'Test',
    last_name: 'Recipient',
    amount_formatted: '$250.00',
    amount_cents: 25000,
    invoice_number: 'TEST-0001',
    invoice_title: 'September Tuition (TEST)',
    invoice_description: 'Sample invoice for workflow testing',
    due_date: today.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
    due_date_iso: today.toISOString(),
    pay_url: 'https://growth-suite-parent-portal.vercel.app/pay/invoice/test?t=sample',
    card_summary: '',
    payment_date: '',
    payment_date_iso: today.toISOString(),
    school_name: row.name ?? 'Your School',
    receipt_url: 'https://growth-suite-parent-portal.vercel.app/pay/invoice/test?t=sample',
    failure_reason: '',
    school_id: schoolId,
    ghl_location_id: '',
    _test: true,
  };

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    let status = 0;
    try {
      const res = await fetch(row.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'GrowthSuite-PaymentWebhook/1' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      status = res.status;
    } finally {
      clearTimeout(timer);
    }
    if (status >= 200 && status < 300) {
      return back(request, schoolId, { msg: `Test payload sent to Growth Suite (HTTP ${status}). Check your workflow.` }, returnTo);
    }
    return back(request, schoolId, { err: `Growth Suite webhook returned HTTP ${status}. Double-check the URL.` }, returnTo);
  } catch (e) {
    return back(request, schoolId, { err: `Couldn't reach the webhook: ${e instanceof Error ? e.message : String(e)}` }, returnTo);
  }
}
