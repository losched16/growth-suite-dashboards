// POST /api/admin/schools/{schoolId}/payments/fa-to-discount
//
// Takes a decided fa_applications row and creates a matching
// discount_policies row of kind='financial_aid'. The discount is keyed
// to fa_application_id so the parent-portal discount evaluator only
// applies it for the awarded family (and only while the FA application
// remains in status='decided').
//
// Body (JSON): { fa_application_id: uuid }
// Response: { ok: true, discount_policy_id: uuid } or { error }
//
// Idempotent: if a discount policy already exists for this FA
// application, returns 200 with the existing id.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { syncFaDiscountForApplication } from '@/lib/billing/fa-discount';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string }>;

interface Body { fa_application_id?: string }

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId } = await params;

  let body: Body = {};
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }

  const faId = body.fa_application_id;
  if (!faId) {
    return NextResponse.json({ error: 'missing_fa_application_id' }, { status: 400 });
  }

  // Load + validate the FA application
  const { rows: faRows } = await query<{
    id: string;
    school_id: string;
    family_id: string;
    academic_year: string;
    status: string;
    recommended_award: string | null;
  }>(
    `SELECT id, school_id, family_id, academic_year, status, recommended_award
       FROM fa_applications WHERE id = $1`,
    [faId],
  );
  const fa = faRows[0];
  if (!fa) return NextResponse.json({ error: 'fa_not_found' }, { status: 404 });
  if (fa.school_id !== schoolId) {
    return NextResponse.json({ error: 'wrong_school' }, { status: 403 });
  }
  if (fa.status !== 'decided') {
    return NextResponse.json({ error: 'fa_not_decided', detail: `status=${fa.status}` }, { status: 409 });
  }
  const awardDollars = Number(fa.recommended_award ?? 0);
  if (!Number.isFinite(awardDollars) || awardDollars <= 0) {
    return NextResponse.json({ error: 'no_recommended_award' }, { status: 409 });
  }

  // Delegate the actual create/update to the shared sync helper so the
  // manual button and the automatic fa/set-award path can never drift.
  // (Note: set-award now auto-syncs on decision, so this button is a
  // manual re-sync / safety net rather than the primary path.)
  const result = await syncFaDiscountForApplication(query, schoolId, faId);
  return NextResponse.json({
    ok: true,
    discount_policy_id: result.discountPolicyId,
    action: result.action,
  });
}
