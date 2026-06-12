// POST /api/school/family-credits — family credit ledger actions.
//
//   action=add    school_id, family_id, amount (dollars), reason
//                 → adds a credit to the family's account
//   action=apply  school_id, invoice_id
//                 → applies available family credit to the invoice:
//                   consumes credits FIFO, adds ONE negative
//                   "Account credit" line, reduces total_cents; if the
//                   balance hits zero the invoice flips to paid.
//
// Plain HTML form posts (formData) with return_to redirect, matching
// the other embedded /school endpoints.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query, withTransaction } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function safeReturn(returnTo: string | null, fallback: string): string {
  if (returnTo && /^\/(admin|school)\/[A-Za-z0-9_-]+(\/[^?#]*)?(\?[^#]*)?$/.test(returnTo)) return returnTo;
  return fallback;
}
function back(request: NextRequest, q: { msg?: string; err?: string }, returnTo: string | null) {
  const url = request.nextUrl.clone();
  const target = safeReturn(returnTo, '/admin');
  const [path, qs] = target.split('?');
  url.pathname = path;
  url.search = qs ? `?${qs}` : '';
  if (q.msg) url.searchParams.set('msg', q.msg);
  if (q.err) url.searchParams.set('err', q.err);
  return NextResponse.redirect(url, 303);
}

export async function POST(request: NextRequest) {
  const fd = await request.formData();
  const action = String(fd.get('action') ?? '').trim();
  const returnTo = String(fd.get('return_to') ?? '').trim() || null;
  const schoolId = String(fd.get('school_id') ?? '').trim();
  if (!schoolId) return back(request, { err: 'school_id required' }, returnTo);

  if (action === 'add') {
    const familyId = String(fd.get('family_id') ?? '').trim();
    const amountCents = Math.round(parseFloat(String(fd.get('amount') ?? '0')) * 100);
    const reason = String(fd.get('reason') ?? '').trim().slice(0, 500) || null;
    if (!familyId) return back(request, { err: 'Pick a family.' }, returnTo);
    if (!Number.isFinite(amountCents) || amountCents <= 0 || amountCents > 100_000_00) {
      return back(request, { err: 'Enter a credit amount between $0.01 and $100,000.' }, returnTo);
    }
    await query(
      `INSERT INTO family_credits (school_id, family_id, amount_cents, remaining_cents, reason, created_by_email)
       VALUES ($1,$2,$3,$3,$4,'operator@growthsuite.local')`,
      [schoolId, familyId, amountCents, reason],
    );
    return back(request, { msg: `Credit of $${(amountCents / 100).toFixed(2)} added to the family's account.` }, returnTo);
  }

  if (action === 'apply') {
    const invoiceId = String(fd.get('invoice_id') ?? '').trim();
    if (!invoiceId) return back(request, { err: 'invoice_id required' }, returnTo);

    try {
      const applied = await withTransaction(async (q) => {
        const { rows: invRows } = await q<{
          id: string; family_id: string | null; status: string;
          total_cents: number; amount_paid_cents: number; discount_total_cents: number;
        }>(
          `SELECT id, family_id, status, total_cents, amount_paid_cents, discount_total_cents
             FROM invoices WHERE id = $1 AND school_id = $2 FOR UPDATE`,
          [invoiceId, schoolId],
        );
        const inv = invRows[0];
        if (!inv) throw new Error('Invoice not found.');
        if (!inv.family_id) throw new Error('Credits apply to family invoices only.');
        if (!['draft', 'open', 'partially_paid'].includes(inv.status)) throw new Error(`Invoice is ${inv.status} — nothing to apply.`);
        const owed = inv.total_cents - inv.amount_paid_cents;
        if (owed <= 0) throw new Error('Invoice has no balance due.');

        const { rows: credits } = await q<{ id: string; remaining_cents: number }>(
          `SELECT id, remaining_cents FROM family_credits
            WHERE school_id = $1 AND family_id = $2 AND remaining_cents > 0
            ORDER BY created_at FOR UPDATE`,
          [schoolId, inv.family_id],
        );
        const available = credits.reduce((a, c) => a + c.remaining_cents, 0);
        if (available <= 0) throw new Error('No credit available on this family\'s account.');

        let toApply = Math.min(owed, available);
        const totalApplied = toApply;
        for (const c of credits) {
          if (toApply <= 0) break;
          const take = Math.min(c.remaining_cents, toApply);
          await q(`UPDATE family_credits SET remaining_cents = remaining_cents - $2, updated_at = now() WHERE id = $1`, [c.id, take]);
          await q(`INSERT INTO credit_applications (credit_id, invoice_id, amount_cents) VALUES ($1,$2,$3)`, [c.id, invoiceId, take]);
          toApply -= take;
        }

        const { rows: posRows } = await q<{ p: number }>(
          `SELECT COALESCE(MAX(position), -1) + 1 AS p FROM invoice_line_items WHERE invoice_id = $1`, [invoiceId],
        );
        await q(
          `INSERT INTO invoice_line_items (invoice_id, position, description, quantity, unit_amount_cents, amount_cents, category)
           VALUES ($1,$2,'Account credit applied',1,$3,$3,'credit')`,
          [invoiceId, posRows[0].p, -totalApplied],
        );

        const newTotal = inv.total_cents - totalApplied;
        const fullyCovered = inv.amount_paid_cents >= newTotal;
        await q(
          `UPDATE invoices SET total_cents = $2,
                  discount_total_cents = discount_total_cents + $3,
                  status = CASE WHEN $4 AND status IN ('open','partially_paid') THEN 'paid' ELSE status END,
                  paid_at = CASE WHEN $4 AND status IN ('open','partially_paid') THEN now() ELSE paid_at END,
                  updated_at = now()
            WHERE id = $1`,
          [invoiceId, newTotal, totalApplied, fullyCovered],
        );
        return totalApplied;
      });
      return back(request, { msg: `Applied $${(applied / 100).toFixed(2)} of family credit to this invoice.` }, returnTo);
    } catch (e) {
      return back(request, { err: e instanceof Error ? e.message : String(e) }, returnTo);
    }
  }

  return back(request, { err: 'Unknown action.' }, returnTo);
}
