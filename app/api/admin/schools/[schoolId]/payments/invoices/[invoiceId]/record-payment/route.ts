// POST /api/admin/schools/{schoolId}/payments/invoices/{invoiceId}/record-payment
//
// Record an offline payment (check / cash / bank transfer / other) against any
// invoice — tuition installment OR one-off charge. No card is charged; this
// just marks the invoice paid / partially paid. See lib/billing/record-offline-payment.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { withTransaction } from '@/lib/db';
import { authorizeOperatorOrSchool } from '@/lib/auth/dual';
import { recordOfflinePayment } from '@/lib/billing/record-offline-payment';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string; invoiceId: string }>;

function dollarsToCents(s: string): number {
  const n = parseFloat(s);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId, invoiceId } = await params;
  const auth = await authorizeOperatorOrSchool(schoolId);
  if (!auth.ok) return auth.response;

  const fd = await request.formData();
  const amountCents = dollarsToCents(String(fd.get('amount') ?? ''));
  const method = String(fd.get('method') ?? 'check').trim() || 'check';
  const reference = String(fd.get('reference') ?? '').trim();
  const paidDateRaw = String(fd.get('paid_date') ?? '').trim();
  const paidDate = /^\d{4}-\d{2}-\d{2}$/.test(paidDateRaw) ? paidDateRaw : null;

  const returnTo = String(fd.get('return_to') ?? '').trim();
  const safeReturnPath = /^\/school\/[A-Za-z0-9_-]+\/payments\/invoices\/[A-Za-z0-9_-]+$/.test(returnTo)
    ? returnTo
    : `/admin/${schoolId}/payments/invoices/${invoiceId}`;
  const url = new URL(safeReturnPath, request.url);

  try {
    const result = await withTransaction((q) =>
      recordOfflinePayment(q, { schoolId, invoiceId, amountCents, method, reference, paidDate }),
    );
    if (!result.ok) {
      url.searchParams.set('err', result.error ?? 'Could not record payment.');
    } else {
      url.searchParams.set('msg',
        `Recorded $${((result.amountCents ?? 0) / 100).toFixed(2)} ${result.method} payment. Invoice marked ${result.fullyPaid ? 'PAID (removed from autopay).' : 'partially paid.'}`);
    }
  } catch (err) {
    url.searchParams.set('err', `Could not record payment: ${err instanceof Error ? err.message : String(err)}`);
  }
  return NextResponse.redirect(url, 303);
}
