// POST /api/admin/schools/{schoolId}/payments/invoices/{invoiceId}/autopay
//
// Enable or disable autopay on an invoice. Optionally select the
// payment method to use (otherwise uses the family's default).
//
// Body form fields:
//   action          'enable' | 'disable'
//   method_id       uuid (required when action=enable; falls back to default)
//   charge_on       YYYY-MM-DD (optional; default = due_at::date)

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { authorizeOperatorOrSchool } from '@/lib/auth/dual';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string; invoiceId: string }>;

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId, invoiceId } = await params;
  const _auth = await authorizeOperatorOrSchool(schoolId);
  if (!_auth.ok) return _auth.response;
  const fd = await request.formData();
  const action = String(fd.get('action') ?? '').trim();
  // School-scoped pages send a /school/{locationId}/payments/invoices/{id}
  // path so the redirect keeps the operator inside the iframe.
  const returnTo = String(fd.get('return_to') ?? '').trim();
  const safeReturnPath = /^\/school\/[A-Za-z0-9_-]+\/payments\/invoices\/[A-Za-z0-9_-]+$/.test(returnTo)
    ? returnTo
    : `/admin/${schoolId}/payments/invoices/${invoiceId}`;

  const url = new URL(safeReturnPath, request.url);

  if (action === 'disable') {
    await query(
      `UPDATE invoices
          SET autopay_enabled = false,
              autopay_payment_method_id = NULL,
              autopay_charge_on = NULL,
              next_retry_at = NULL,
              updated_at = now()
        WHERE id = $1 AND school_id = $2`,
      [invoiceId, schoolId],
    );
    url.searchParams.set('msg', 'Autopay disabled for this invoice.');
    return NextResponse.redirect(url, 303);
  }

  if (action === 'enable') {
    // Get the family for this invoice
    const { rows: invRows } = await query<{ family_id: string }>(
      `SELECT family_id FROM invoices WHERE id = $1 AND school_id = $2`,
      [invoiceId, schoolId],
    );
    if (invRows.length === 0) {
      url.searchParams.set('err', 'Invoice not found.');
      return NextResponse.redirect(url, 303);
    }
    const familyId = invRows[0].family_id;

    // Resolve the payment method: explicit method_id, else family's default.
    let methodId = String(fd.get('method_id') ?? '').trim() || null;
    if (!methodId) {
      const { rows: pmRows } = await query<{ id: string }>(
        `SELECT id FROM payment_methods
          WHERE school_id = $1 AND family_id = $2 AND active = true
          ORDER BY is_default DESC, created_at DESC LIMIT 1`,
        [schoolId, familyId],
      );
      methodId = pmRows[0]?.id ?? null;
    }
    if (!methodId) {
      url.searchParams.set('err',
        'Cannot enable autopay — this family has no saved payment method. They need to save one on their first payment.');
      return NextResponse.redirect(url, 303);
    }

    const chargeOn = String(fd.get('charge_on') ?? '').trim() || null;
    await query(
      `UPDATE invoices
          SET autopay_enabled = true,
              autopay_payment_method_id = $1,
              autopay_charge_on = $2,
              retry_attempt_count = 0,
              next_retry_at = NULL,
              updated_at = now()
        WHERE id = $3 AND school_id = $4`,
      [methodId, chargeOn, invoiceId, schoolId],
    );

    url.searchParams.set('msg', 'Autopay enabled. The system will charge the family on the scheduled date.');
    return NextResponse.redirect(url, 303);
  }

  url.searchParams.set('err', `Unknown action: ${action}`);
  return NextResponse.redirect(url, 303);
}
