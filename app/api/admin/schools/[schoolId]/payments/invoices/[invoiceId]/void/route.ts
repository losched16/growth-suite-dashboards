// POST /api/admin/schools/{schoolId}/payments/invoices/{invoiceId}/void
//
// Voids an invoice. Optional `reason` form field.

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
  const reason = String(fd.get('reason') ?? '').trim() || 'No reason given';
  // School-scoped pages send a /school/{locationId}/payments/invoices/{id}
  // path so the redirect keeps the operator inside the iframe.
  const returnTo = String(fd.get('return_to') ?? '').trim();
  const safeReturnPath = /^\/school\/[A-Za-z0-9_-]+\/payments\/invoices\/[A-Za-z0-9_-]+$/.test(returnTo)
    ? returnTo
    : `/admin/${schoolId}/payments/invoices/${invoiceId}`;

  const r = await query(
    `UPDATE invoices
        SET status = 'voided', voided_at = now(), voided_reason = $1, updated_at = now()
      WHERE id = $2 AND school_id = $3 AND status IN ('draft', 'open', 'partially_paid')`,
    [reason, invoiceId, schoolId],
  );
  const url = new URL(safeReturnPath, request.url);
  if (r.rowCount === 0) {
    url.searchParams.set('err', 'Invoice could not be voided in its current status.');
  } else {
    url.searchParams.set('msg', 'Invoice voided.');
  }
  return NextResponse.redirect(url, 303);
}
