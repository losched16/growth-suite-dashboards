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
  const awardCents = Math.round(awardDollars * 100);

  // Idempotent: return existing policy if one already points at this FA app.
  const { rows: existingRows } = await query<{ id: string }>(
    `SELECT id FROM discount_policies
      WHERE school_id = $1 AND fa_application_id = $2 LIMIT 1`,
    [schoolId, faId],
  );
  if (existingRows[0]) {
    // Refresh the amount in case the operator bumped the award since the
    // policy was first created. Re-activates if it was disabled.
    await query(
      `UPDATE discount_policies
          SET amount_cents = $1,
              max_discount_cents = $1,
              is_active = true,
              updated_at = now()
        WHERE id = $2`,
      [awardCents, existingRows[0].id],
    );
    return NextResponse.json({ ok: true, discount_policy_id: existingRows[0].id, action: 'updated' });
  }

  // Resolve family display name for the policy label
  const { rows: famRows } = await query<{ display_name: string | null }>(
    `SELECT COALESCE(NULLIF(f.display_name, ''),
                     CONCAT_WS(' ', p.first_name, p.last_name),
                     '(unnamed family)') AS display_name
       FROM families f
       LEFT JOIN LATERAL (
         SELECT first_name, last_name FROM parents
         WHERE family_id = f.id AND is_primary = true LIMIT 1
       ) p ON true
      WHERE f.id = $1`,
    [fa.family_id],
  );
  const familyName = famRows[0]?.display_name ?? 'Family';

  const ins = await query<{ id: string }>(
    `INSERT INTO discount_policies
       (school_id, kind, display_name, amount_cents, max_discount_cents,
        applies_to_categories, conditions, fa_application_id, is_active)
     VALUES ($1, 'financial_aid', $2, $3, $3, $4, '{}'::jsonb, $5, true)
     RETURNING id`,
    [
      schoolId,
      `Financial aid — ${familyName} (${fa.academic_year})`,
      awardCents,
      // Cap which line categories this can be subtracted from. Tuition +
      // tuition_addon line categories cover the installment generator's
      // output. Leave 'trip' etc. unaffected.
      ['tuition', 'tuition_addon'],
      faId,
    ],
  );

  return NextResponse.json({ ok: true, discount_policy_id: ins.rows[0].id, action: 'created' });
}
