// POST /api/school/billing/go-live
//
// Atomically flips the school's billing_active flag from false to true
// AND promotes every existing draft tuition-plan invoice to 'open'
// status. From that moment forward:
//   - New invoices are emitted as 'open' (parents see + can pay them)
//   - Autopay cron starts processing this school's invoices
//   - Notification emails to parents fire normally
//
// Reverse operation: not exposed here. Once a school has charged a real
// parent, "going back to dry-run" is a support-level operation that
// requires the operator to manually pause specific enrollments / void
// invoices — we don't want a single button that hides already-issued
// bills from parents.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { withTransaction } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function bounce(request: NextRequest, returnTo: string | null, qs: { msg?: string; err?: string }) {
  const fallback = '/school/_/payments';
  const base = returnTo && /^\/school\/[A-Za-z0-9_-]+\//.test(returnTo) ? returnTo : fallback;
  const url = new URL(base, request.url);
  if (qs.msg) url.searchParams.set('msg', qs.msg);
  if (qs.err) url.searchParams.set('err', qs.err);
  return NextResponse.redirect(url, 303);
}

export async function POST(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let fd: FormData;
  try { fd = await request.formData(); }
  catch { return NextResponse.json({ error: 'invalid_form_data' }, { status: 400 }); }

  const returnTo = String(fd.get('return_to') ?? '').trim() || null;
  const confirm = String(fd.get('confirm') ?? '').trim();
  if (confirm !== 'GO_LIVE') {
    return bounce(request, returnTo, {
      err: 'Confirmation phrase required — type GO_LIVE exactly to proceed.',
    });
  }

  // Operator email is best-effort — the school session doesn't carry a
  // real one today (auto-mint uses 'embed@iframe'). We capture whatever
  // the session has so the audit trail at least shows "came in via GHL."
  const operatorEmail = session.user_email && session.user_email !== 'embed@iframe'
    ? session.user_email
    : `school-iframe@${session.ghl_location_id}`;

  try {
    const result = await withTransaction(async (q) => {
      // 1) Flip the flag. Idempotent: if already true, no-op.
      const upd = await q<{ was_active: boolean }>(
        `UPDATE school_payment_config
            SET billing_active = true,
                billing_activated_at = COALESCE(billing_activated_at, now()),
                billing_activated_by_email = COALESCE(billing_activated_by_email, $2),
                updated_at = now()
          WHERE school_id = $1
        RETURNING (billing_active = true) AS was_active`,
        [session.school_id, operatorEmail],
      );
      if (upd.rowCount === 0) {
        throw new Error('school_payment_config row not found — provision the school first.');
      }

      // 2) Promote all existing tuition-plan drafts to 'open'. Issued_at
      // stamped now so the parent portal sees them appear "today" rather
      // than the original creation date. Past-due drafts go open with
      // their original due date intact (parent sees them as immediately
      // overdue, which is the right signal).
      const promoted = await q<{ id: string }>(
        `UPDATE invoices
            SET status = 'open',
                issued_at = COALESCE(issued_at, now()),
                updated_at = now()
          WHERE school_id = $1
            AND source = 'tuition_plan'
            AND status = 'draft'
        RETURNING id`,
        [session.school_id],
      );

      return { promotedCount: promoted.rowCount ?? 0 };
    });

    return bounce(request, returnTo, {
      msg: result.promotedCount > 0
        ? `Billing is live. ${result.promotedCount} draft invoice${result.promotedCount === 1 ? '' : 's'} promoted to open — parents can now see them in their portal, and autopay will run on the next scheduled day.`
        : 'Billing is live. No draft invoices to promote — new invoices will emit as open going forward.',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return bounce(request, returnTo, { err: `Could not go live: ${msg}` });
  }
}
