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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string }>;

function back(request: NextRequest, schoolId: string, q: { msg?: string; err?: string }) {
  const url = request.nextUrl.clone();
  url.pathname = `/admin/${schoolId}/payments`;
  url.search = '';
  if (q.msg) url.searchParams.set('msg', q.msg);
  if (q.err) url.searchParams.set('err', q.err);
  return NextResponse.redirect(url, 303);
}

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId } = await params;

  const { rows } = await query<{ url: string | null; name: string | null }>(
    `SELECT cfg.ghl_receipt_webhook_url AS url, s.name
       FROM schools s
       LEFT JOIN school_payment_config cfg ON cfg.school_id = s.id
      WHERE s.id = $1`,
    [schoolId],
  );
  const row = rows[0];
  if (!row?.url) {
    return back(request, schoolId, { err: 'No GHL webhook URL configured. Save one first.' });
  }

  const payload = {
    event: 'payment.succeeded',
    contact_id: '',
    email: 'test-parent@example.com',
    phone: '',
    first_name: 'Test',
    last_name: 'Parent',
    amount_formatted: '$250.00',
    amount_cents: 25000,
    invoice_number: 'TEST-0001',
    invoice_title: 'September Tuition (TEST)',
    card_summary: 'VISA ····4242',
    payment_date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
    payment_date_iso: new Date().toISOString(),
    school_name: row.name ?? 'Your School',
    receipt_url: 'https://growth-suite-parent-portal.vercel.app/billing/pay/test',
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
      return back(request, schoolId, { msg: `Test payload sent to GHL (HTTP ${status}). Check your workflow in GHL.` });
    }
    return back(request, schoolId, { err: `GHL webhook returned HTTP ${status}. Double-check the URL.` });
  } catch (e) {
    return back(request, schoolId, { err: `Couldn't reach the webhook: ${e instanceof Error ? e.message : String(e)}` });
  }
}
