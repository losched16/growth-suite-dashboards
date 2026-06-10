// POST /api/admin/schools/{schoolId}/payments/invoices/{invoiceId}/send
//
// Marks the invoice 'open' (if it was draft), stamps issued_at, and
// fires the "you have a new invoice" email to all active parents in
// the family via the school's per-school sender (Resend).
//
// Allow re-send on already-open invoices — operator may want to resend
// after fixing a parent email. Only paid/voided invoices are blocked.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { sendInvoiceEmail } from '@/lib/billing/send-invoice-email';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type Params = Promise<{ schoolId: string; invoiceId: string }>;

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId, invoiceId } = await params;
  const fd = await request.formData();
  // School-scoped pages send a /school/{locationId}/payments/invoices/{id}
  // path here so the redirect keeps the operator inside the iframe.
  const returnTo = String(fd.get('return_to') ?? '').trim();
  const safeReturnPath = /^\/school\/[A-Za-z0-9_-]+\/payments\/invoices\/[A-Za-z0-9_-]+$/.test(returnTo)
    ? returnTo
    : `/admin/${schoolId}/payments/invoices/${invoiceId}`;

  const r = await query<{ status: string }>(
    `UPDATE invoices
        SET status = CASE WHEN status = 'draft' THEN 'open' ELSE status END,
            issued_at = COALESCE(issued_at, now()),
            updated_at = now()
      WHERE id = $1 AND school_id = $2 AND status IN ('draft', 'open', 'partially_paid')
      RETURNING status`,
    [invoiceId, schoolId],
  );

  const url = new URL(safeReturnPath, request.url);
  if (r.rowCount === 0) {
    url.searchParams.set('err', 'Invoice could not be sent (probably paid or voided).');
    return NextResponse.redirect(url, 303);
  }

  try {
    const result = await sendInvoiceEmail({ invoiceId });
    if (result.ghl_notified) {
      url.searchParams.set('msg',
        'Invoice sent via your Growth Suite workflow.'
        + (result.sent_to.length > 0 ? ` Also emailed ${result.sent_to.length}.` : ''));
    } else if (result.sent_to.length > 0) {
      url.searchParams.set('msg',
        `Invoice sent to ${result.sent_to.length} recipient(s): ${result.sent_to.join(', ')}.`
        + (result.skipped.length > 0 ? ` ${result.skipped.length} failed.` : ''));
    } else {
      url.searchParams.set('err',
        'Status updated, but no delivery channel is set up — connect a Growth Suite workflow webhook (Payments → Settings), or copy the pay link to share it manually.');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    url.searchParams.set('err', `Status updated but delivery failed: ${msg}`);
  }
  return NextResponse.redirect(url, 303);
}
