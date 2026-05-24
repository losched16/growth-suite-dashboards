// POST /api/admin/schools/{schoolId}/tuition-plans/{enrollmentId}/action
//
// Single dispatcher for all plan-level modifications. The `action` form
// field selects the operation. Always 303-redirects back to the
// caller's `return_to` (validated) so the form submission lands on the
// plan detail page with a success/error toast.
//
// Actions:
//   pause                — UPDATE enrollment SET status='paused'
//   resume               — UPDATE enrollment SET status='active'
//   edit_installment     — Replace one invoice's due_at + total_cents
//                          + line items (single "adjusted" line).
//                          Inputs: invoice_id, due_date, amount
//   split_installment    — Void original, create two new invoices for
//                          the same enrollment. Inputs: invoice_id,
//                          first_due, first_amount, second_due, second_amount
//   reschedule_remaining — Void all open + draft invoices and re-spread
//                          the unpaid balance across N new installments.
//                          Inputs: new_count, start_date, cadence
//
// Money values come in as dollars (form fields use type=number with
// step=0.01). We convert to integer cents server-side.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query, withTransaction } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type Params = Promise<{ schoolId: string; enrollmentId: string }>;

// ── Helpers ──────────────────────────────────────────────────────────

function dollarsToCents(s: string): number {
  const n = parseFloat(s);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}

function back(
  request: NextRequest,
  fallbackPath: string,
  returnTo: string | null,
  q: { msg?: string; err?: string },
) {
  // Honor return_to if it's a relative /school/.../plans/... path —
  // otherwise fall back. Prevents open-redirect.
  const isSafe = returnTo
    && /^\/(school|admin)\/[A-Za-z0-9_-]+\/payments\/plans\/[A-Za-z0-9-]+$/.test(returnTo);
  const target = isSafe ? returnTo! : fallbackPath;
  const [path, qs] = target.split('?');
  const url = request.nextUrl.clone();
  url.pathname = path;
  url.search = qs ? `?${qs}` : '';
  if (q.msg) url.searchParams.set('msg', q.msg);
  if (q.err) url.searchParams.set('err', q.err);
  return NextResponse.redirect(url, 303);
}

// Allocate the next invoice number for this school. Mirrors the logic
// in the manual-create route + the installment generator.
async function nextInvoiceNumber(
  schoolId: string,
  q: typeof query,
): Promise<string> {
  const { rows } = await q<{ prefix: string; next: number }>(
    `INSERT INTO school_payment_config (school_id) VALUES ($1)
     ON CONFLICT (school_id) DO UPDATE
       SET next_invoice_number = school_payment_config.next_invoice_number + 1
     RETURNING invoice_number_prefix AS prefix, next_invoice_number AS next`,
    [schoolId],
  );
  const r = rows[0];
  const seq = r.next > 1 ? r.next - 1 : 1;
  return `${r.prefix}-${String(seq).padStart(6, '0')}`;
}

// Replace an invoice's line items with a single consolidated line.
async function rewriteSingleLine(
  invoiceId: string,
  description: string,
  amountCents: number,
  studentId: string | null,
  q: typeof query,
) {
  await q(`DELETE FROM invoice_line_items WHERE invoice_id = $1`, [invoiceId]);
  await q(
    `INSERT INTO invoice_line_items
       (invoice_id, position, description, quantity, unit_amount_cents, amount_cents, category, student_id)
     VALUES ($1, 0, $2, 1, $3, $3, 'tuition', $4)`,
    [invoiceId, description, amountCents, studentId],
  );
}

// ── Dispatcher ───────────────────────────────────────────────────────

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId, enrollmentId } = await params;
  const fd = await request.formData();
  const action = String(fd.get('action') ?? '').trim();
  const returnTo = String(fd.get('return_to') ?? '').trim() || null;
  const fallback = `/admin/${schoolId}/payments`; // operator namespace fallback

  // Verify the enrollment exists + belongs to the school. Pull metadata
  // we'll need across most actions.
  const { rows: eRows } = await query<{
    id: string; school_id: string; family_id: string; student_id: string | null;
    academic_year: string; status: string;
  }>(
    `SELECT id, school_id, family_id, student_id, academic_year, status
       FROM family_tuition_enrollments
      WHERE id = $1 AND school_id = $2`,
    [enrollmentId, schoolId],
  );
  if (eRows.length === 0) {
    return back(request, fallback, returnTo, { err: 'Enrollment not found.' });
  }
  const enr = eRows[0];

  try {
    switch (action) {
      // ── pause ────────────────────────────────────────────────────────
      case 'pause': {
        await query(
          `UPDATE family_tuition_enrollments SET status='paused', updated_at=now()
            WHERE id = $1`, [enrollmentId],
        );
        return back(request, fallback, returnTo, { msg: 'Plan paused. Existing invoices remain live until you resume or void them individually.' });
      }

      // ── resume ───────────────────────────────────────────────────────
      case 'resume': {
        await query(
          `UPDATE family_tuition_enrollments SET status='active', updated_at=now()
            WHERE id = $1`, [enrollmentId],
        );
        return back(request, fallback, returnTo, { msg: 'Plan resumed.' });
      }

      // ── edit_installment ─────────────────────────────────────────────
      case 'edit_installment': {
        const invoiceId = String(fd.get('invoice_id') ?? '').trim();
        const dueDate = String(fd.get('due_date') ?? '').trim();
        const amountCents = dollarsToCents(String(fd.get('amount') ?? '0'));

        if (!invoiceId) return back(request, fallback, returnTo, { err: 'invoice_id missing.' });
        if (!dueDate)   return back(request, fallback, returnTo, { err: 'Due date required.' });
        if (amountCents <= 0) return back(request, fallback, returnTo, { err: 'Amount must be > 0.' });

        // Verify the invoice belongs to this enrollment + is editable.
        const { rows: iRows } = await query<{
          id: string; status: string; amount_paid_cents: number; installment_number: number | null;
        }>(
          `SELECT i.id, i.status, i.amount_paid_cents,
                  (i.source_ref->>'installment_number')::int AS installment_number
             FROM invoices i
            WHERE i.id = $1 AND i.school_id = $2
              AND i.source = 'tuition_plan'
              AND i.source_ref->>'enrollment_id' = $3`,
          [invoiceId, schoolId, enrollmentId],
        );
        if (iRows.length === 0) {
          return back(request, fallback, returnTo, { err: 'Invoice not found for this plan.' });
        }
        const inv = iRows[0];
        if (inv.status !== 'open' && inv.status !== 'draft') {
          return back(request, fallback, returnTo, { err: `Cannot edit a ${inv.status} invoice. Void it or create a new one instead.` });
        }
        if (inv.amount_paid_cents > 0) {
          return back(request, fallback, returnTo, { err: 'Invoice already has a payment recorded. Void it instead of editing.' });
        }

        await withTransaction(async (q) => {
          await q(
            `UPDATE invoices
                SET total_cents = $1, subtotal_cents = $1, discount_total_cents = 0,
                    platform_fee_cents = 0, processing_fee_cents = 0,
                    due_at = $2::date,
                    updated_at = now()
              WHERE id = $3`,
            [amountCents, dueDate, invoiceId],
          );
          await rewriteSingleLine(
            invoiceId,
            `Tuition installment${inv.installment_number ? ` ${inv.installment_number}` : ''} (adjusted by operator)`,
            amountCents,
            enr.student_id,
            q,
          );
        });

        return back(request, fallback, returnTo, { msg: 'Installment updated.' });
      }

      // ── split_installment ────────────────────────────────────────────
      case 'split_installment': {
        const invoiceId   = String(fd.get('invoice_id') ?? '').trim();
        const firstDue    = String(fd.get('first_due') ?? '').trim();
        const firstAmount = dollarsToCents(String(fd.get('first_amount') ?? '0'));
        const secondDue   = String(fd.get('second_due') ?? '').trim();
        const secondAmount = dollarsToCents(String(fd.get('second_amount') ?? '0'));

        if (!invoiceId || !firstDue || !secondDue) {
          return back(request, fallback, returnTo, { err: 'invoice_id + both due dates required.' });
        }
        if (firstAmount <= 0 || secondAmount <= 0) {
          return back(request, fallback, returnTo, { err: 'Both halves must be > 0.' });
        }

        // Load the original invoice.
        const { rows: iRows } = await query<{
          id: string; status: string; amount_paid_cents: number;
          total_cents: number; installment_number: number | null;
        }>(
          `SELECT i.id, i.status, i.amount_paid_cents, i.total_cents,
                  (i.source_ref->>'installment_number')::int AS installment_number
             FROM invoices i
            WHERE i.id = $1 AND i.school_id = $2
              AND i.source = 'tuition_plan'
              AND i.source_ref->>'enrollment_id' = $3`,
          [invoiceId, schoolId, enrollmentId],
        );
        if (iRows.length === 0) {
          return back(request, fallback, returnTo, { err: 'Invoice not found for this plan.' });
        }
        const inv = iRows[0];
        if (inv.status !== 'open' && inv.status !== 'draft') {
          return back(request, fallback, returnTo, { err: `Cannot split a ${inv.status} invoice.` });
        }
        if (inv.amount_paid_cents > 0) {
          return back(request, fallback, returnTo, { err: 'Cannot split an invoice with payments. Void or refund first.' });
        }

        await withTransaction(async (q) => {
          // Void the original.
          await q(
            `UPDATE invoices
                SET status='voided', voided_at=now(),
                    voided_reason='Split by operator into two installments',
                    updated_at=now()
              WHERE id = $1`,
            [invoiceId],
          );

          // Create two new invoices with the same enrollment_id source_ref.
          for (const [idx, due, amt] of [
            ['a', firstDue,  firstAmount],
            ['b', secondDue, secondAmount],
          ] as Array<[string, string, number]>) {
            const invNum = await nextInvoiceNumber(schoolId, q);
            const title = `Tuition installment ${inv.installment_number ?? '?'}${idx} (split)`;
            const ins = await q<{ id: string }>(
              `INSERT INTO invoices
                 (school_id, family_id, student_id, invoice_number, title, description,
                  status, subtotal_cents, platform_fee_cents, discount_total_cents,
                  total_cents, due_at, issued_at, source, source_ref,
                  includes_platform_setup_fee, created_by_email)
               VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, 0, 0, $7, $8::date, now(),
                       'tuition_plan', $9::jsonb, false, 'operator@growthsuite.local')
               RETURNING id`,
              [
                schoolId, enr.family_id, enr.student_id,
                invNum, title, `Split half of original ${invoiceId.slice(0, 8)}…`,
                amt, due,
                JSON.stringify({
                  enrollment_id: enrollmentId,
                  installment_number: inv.installment_number,
                  split_part: idx,
                  split_from_invoice_id: invoiceId,
                }),
              ],
            );
            await rewriteSingleLine(ins.rows[0].id, title, amt, enr.student_id, q);
          }
        });

        return back(request, fallback, returnTo, { msg: 'Installment split into two.' });
      }

      // ── reschedule_remaining ─────────────────────────────────────────
      case 'reschedule_remaining': {
        const newCount = parseInt(String(fd.get('new_count') ?? '0'), 10);
        const startDate = String(fd.get('start_date') ?? '').trim();
        const cadence = String(fd.get('cadence') ?? 'monthly').trim();

        if (!Number.isFinite(newCount) || newCount < 1 || newCount > 60) {
          return back(request, fallback, returnTo, { err: 'new_count must be between 1 and 60.' });
        }
        if (!startDate) {
          return back(request, fallback, returnTo, { err: 'start_date required.' });
        }
        if (!['monthly', 'biweekly', 'weekly'].includes(cadence)) {
          return back(request, fallback, returnTo, { err: 'cadence must be monthly | biweekly | weekly.' });
        }

        // Compute the unpaid balance from open + draft invoices. Don't
        // touch partially_paid (preserve payment history).
        const { rows: openRows } = await query<{ id: string; total_cents: number }>(
          `SELECT id, total_cents FROM invoices
            WHERE school_id = $1 AND source = 'tuition_plan'
              AND source_ref->>'enrollment_id' = $2
              AND status IN ('open', 'draft')`,
          [schoolId, enrollmentId],
        );
        const totalBalanceCents = openRows.reduce((s, r) => s + r.total_cents, 0);
        if (totalBalanceCents <= 0) {
          return back(request, fallback, returnTo, { err: 'No open/draft installments to reschedule.' });
        }

        await withTransaction(async (q) => {
          // Void existing open invoices.
          for (const r of openRows) {
            await q(
              `UPDATE invoices
                  SET status='voided', voided_at=now(),
                      voided_reason='Replaced by reschedule_remaining',
                      updated_at=now()
                WHERE id = $1`, [r.id],
            );
          }

          // Distribute totalBalanceCents across newCount installments.
          // Remainder goes on the last one.
          const base = Math.floor(totalBalanceCents / newCount);
          const remainder = totalBalanceCents - base * newCount;

          // Compute due dates per cadence.
          const dueDates: Date[] = [];
          const start = new Date(startDate + 'T00:00:00.000Z');
          for (let i = 0; i < newCount; i++) {
            const d = new Date(start.getTime());
            if (cadence === 'monthly') {
              d.setUTCMonth(d.getUTCMonth() + i);
            } else if (cadence === 'biweekly') {
              d.setUTCDate(d.getUTCDate() + i * 14);
            } else {
              d.setUTCDate(d.getUTCDate() + i * 7);
            }
            dueDates.push(d);
          }

          // Create new invoices.
          for (let i = 0; i < newCount; i++) {
            const amt = (i === newCount - 1) ? base + remainder : base;
            const due = dueDates[i].toISOString().slice(0, 10);
            const invNum = await nextInvoiceNumber(schoolId, q);
            const title = `Tuition (rescheduled) — installment ${i + 1}/${newCount}`;
            const ins = await q<{ id: string }>(
              `INSERT INTO invoices
                 (school_id, family_id, student_id, invoice_number, title, description,
                  status, subtotal_cents, platform_fee_cents, discount_total_cents,
                  total_cents, due_at, issued_at, source, source_ref,
                  includes_platform_setup_fee, created_by_email)
               VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, 0, 0, $7, $8::date, now(),
                       'tuition_plan', $9::jsonb, false, 'operator@growthsuite.local')
               RETURNING id`,
              [
                schoolId, enr.family_id, enr.student_id,
                invNum, title, `Rescheduled balance · ${cadence} cadence`,
                amt, due,
                JSON.stringify({
                  enrollment_id: enrollmentId,
                  installment_number: i + 1,
                  reschedule_source: 'remaining',
                }),
              ],
            );
            await rewriteSingleLine(ins.rows[0].id, title, amt, enr.student_id, q);
          }

          // Update enrollment metadata so the headline counts match.
          await q(
            `UPDATE family_tuition_enrollments
                SET installment_count = (
                  SELECT COUNT(*) FROM invoices
                   WHERE school_id = $1 AND source = 'tuition_plan'
                     AND source_ref->>'enrollment_id' = $2
                     AND status NOT IN ('voided')
                ),
                updated_at = now()
              WHERE id = $2`,
            [schoolId, enrollmentId],
          );
        });

        return back(request, fallback, returnTo, {
          msg: `Reschedule applied — $${(totalBalanceCents / 100).toFixed(2)} spread across ${newCount} new installments.`,
        });
      }

      default:
        return back(request, fallback, returnTo, { err: `Unknown action: ${action}` });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return back(request, fallback, returnTo, { err: `Action failed: ${msg}` });
  }
}
