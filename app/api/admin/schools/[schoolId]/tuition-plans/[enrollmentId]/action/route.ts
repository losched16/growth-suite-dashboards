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
import { authorizeOperatorOrSchool } from '@/lib/auth/dual';
import { generateTuitionEnrollment } from '@/lib/billing/tuition-plan-generator';

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

// Like dollarsToCents but preserves sign — used when editing individual
// fee lines, where credit / discount lines are legitimately negative.
function dollarsToCentsSigned(s: string): number {
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return 0;
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
  const auth = await authorizeOperatorOrSchool(schoolId);
  if (!auth.ok) return auth.response;

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
      // Two modes:
      //   • Per-fee mode (preferred): the form posts one `line_<lineId>`
      //     field per fee on the installment. We update each line, keep
      //     untouched ones, and recompute the invoice total as the sum of
      //     the lines — so the fee breakdown the parent sees is preserved.
      //   • Single-amount mode (fallback, for installments that carry just
      //     one consolidated line): the form posts a single `amount` and we
      //     rewrite the invoice to one line, matching the old behavior.
      case 'edit_installment': {
        const invoiceId = String(fd.get('invoice_id') ?? '').trim();
        const dueDate = String(fd.get('due_date') ?? '').trim();

        if (!invoiceId) return back(request, fallback, returnTo, { err: 'invoice_id missing.' });
        if (!dueDate)   return back(request, fallback, returnTo, { err: 'Due date required.' });

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

        const perLineKeys = Array.from(fd.keys()).filter((k) => k.startsWith('line_'));

        if (perLineKeys.length > 0) {
          // Per-fee edit. Load the current lines so we can keep categories,
          // descriptions, student_id, and any line the operator didn't touch.
          const { rows: existingLines } = await query<{
            id: string; description: string; category: string | null;
            amount_cents: number; student_id: string | null;
          }>(
            `SELECT id, description, category, amount_cents, student_id
               FROM invoice_line_items WHERE invoice_id = $1 ORDER BY position`,
            [invoiceId],
          );
          if (existingLines.length === 0) {
            return back(request, fallback, returnTo, { err: 'No fee lines found on this installment.' });
          }

          let chargeCents = 0;   // sum of positive (charge) lines
          let creditCents = 0;   // sum of negative (credit/discount) lines
          const updates: Array<{ id: string; cents: number }> = [];
          for (const ln of existingLines) {
            const raw = fd.get(`line_${ln.id}`);
            // Blank input = leave this fee unchanged. A typed value (incl. 0
            // or a negative for a credit) overrides it.
            const cents = raw != null && String(raw).trim() !== ''
              ? dollarsToCentsSigned(String(raw))
              : ln.amount_cents;
            updates.push({ id: ln.id, cents });
            if (cents >= 0) chargeCents += cents; else creditCents += cents;
          }
          const newTotal = chargeCents + creditCents;
          if (newTotal <= 0) {
            return back(request, fallback, returnTo, { err: 'The fees must add up to more than $0 for this installment.' });
          }

          await withTransaction(async (q) => {
            for (const u of updates) {
              await q(
                `UPDATE invoice_line_items
                    SET amount_cents = $1, unit_amount_cents = $1, quantity = 1
                  WHERE id = $2`,
                [u.cents, u.id],
              );
            }
            await q(
              `UPDATE invoices
                  SET subtotal_cents = $1, discount_total_cents = $2,
                      total_cents = $3, platform_fee_cents = 0, processing_fee_cents = 0,
                      due_at = $4::date, updated_at = now()
                WHERE id = $5`,
              // discount_total_cents stored as a positive magnitude.
              [chargeCents, -creditCents, newTotal, dueDate, invoiceId],
            );
          });

          return back(request, fallback, returnTo, { msg: 'Installment fees updated.' });
        }

        // Single-amount fallback.
        const amountCents = dollarsToCents(String(fd.get('amount') ?? '0'));
        if (amountCents <= 0) return back(request, fallback, returnTo, { err: 'Amount must be > 0.' });

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

        // Mismatch guard: the two halves must equal the original total to the
        // cent — catches a typo before it creates a balance discrepancy.
        if (firstAmount + secondAmount !== inv.total_cents) {
          return back(request, fallback, returnTo, {
            err: `The two halves ($${(firstAmount / 100).toFixed(2)} + $${(secondAmount / 100).toFixed(2)} = $${((firstAmount + secondAmount) / 100).toFixed(2)}) must equal the original installment total of $${(inv.total_cents / 100).toFixed(2)}.`,
          });
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
      // Two modes:
      //   • even split  — spread the balance across N installments on a fixed
      //                   monthly / biweekly / weekly cadence.
      //   • custom      — operator supplies each installment's date + amount
      //                   (cadence='custom', one "date, amount" per line). Full
      //                   flexibility, including a single one-off charge.
      // In BOTH modes the new installments must total the outstanding balance
      // to the cent — a mismatch is rejected (the typo guard Kim asked for).
      case 'reschedule_remaining': {
        const cadence = String(fd.get('cadence') ?? 'monthly').trim();

        // Unpaid balance = open + draft tuition invoices (paid ones preserved).
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

        // Build the target installments [{ due, cents }] for the chosen mode.
        const plan: Array<{ due: string; cents: number }> = [];

        if (cadence === 'custom') {
          const raw = String(fd.get('custom_schedule') ?? '').trim();
          if (!raw) {
            return back(request, fallback, returnTo, { err: 'Custom schedule is empty — enter one "date, amount" per line (e.g. 2026-09-01, 500). One line = a single one-off charge.' });
          }
          const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
          for (let i = 0; i < lines.length; i++) {
            const parts = lines[i].split(',').map((p) => p.trim());
            const dateStr = parts[0] ?? '';
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
              return back(request, fallback, returnTo, { err: `Line ${i + 1} ("${lines[i]}"): the date must be YYYY-MM-DD.` });
            }
            const cents = dollarsToCents(parts[1] ?? '');
            if (cents <= 0) {
              return back(request, fallback, returnTo, { err: `Line ${i + 1} ("${lines[i]}"): the amount must be greater than $0.` });
            }
            plan.push({ due: dateStr, cents });
          }
          // Mismatch guard — the custom installments must total the balance.
          const sum = plan.reduce((s, p) => s + p.cents, 0);
          if (sum !== totalBalanceCents) {
            return back(request, fallback, returnTo, {
              err: `Your ${plan.length} custom installment(s) total $${(sum / 100).toFixed(2)}, but the outstanding balance is $${(totalBalanceCents / 100).toFixed(2)}. Adjust the amounts so they match exactly before applying.`,
            });
          }
        } else {
          const newCount = parseInt(String(fd.get('new_count') ?? '0'), 10);
          const startDate = String(fd.get('start_date') ?? '').trim();
          if (!Number.isFinite(newCount) || newCount < 1 || newCount > 60) {
            return back(request, fallback, returnTo, { err: 'Number of installments must be between 1 and 60.' });
          }
          if (!startDate) {
            return back(request, fallback, returnTo, { err: 'Start date required.' });
          }
          if (!['monthly', 'biweekly', 'weekly'].includes(cadence)) {
            return back(request, fallback, returnTo, { err: 'Cadence must be monthly, biweekly, weekly, or custom.' });
          }
          // Even split; remainder lands on the last installment so the parent
          // always pays the exact balance.
          const base = Math.floor(totalBalanceCents / newCount);
          const remainder = totalBalanceCents - base * newCount;
          const start = new Date(startDate + 'T00:00:00.000Z');
          for (let i = 0; i < newCount; i++) {
            const d = new Date(start.getTime());
            if (cadence === 'monthly') d.setUTCMonth(d.getUTCMonth() + i);
            else if (cadence === 'biweekly') d.setUTCDate(d.getUTCDate() + i * 14);
            else d.setUTCDate(d.getUTCDate() + i * 7);
            plan.push({ due: d.toISOString().slice(0, 10), cents: i === newCount - 1 ? base + remainder : base });
          }
        }

        await withTransaction(async (q) => {
          for (const r of openRows) {
            await q(
              `UPDATE invoices
                  SET status='voided', voided_at=now(),
                      voided_reason='Replaced by reschedule_remaining',
                      updated_at=now()
                WHERE id = $1`, [r.id],
            );
          }
          for (let i = 0; i < plan.length; i++) {
            const { due, cents } = plan[i];
            const invNum = await nextInvoiceNumber(schoolId, q);
            const title = `Tuition (rescheduled) — installment ${i + 1}/${plan.length}`;
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
                invNum, title, `Rescheduled balance · ${cadence}`,
                cents, due,
                JSON.stringify({ enrollment_id: enrollmentId, installment_number: i + 1, reschedule_source: 'remaining' }),
              ],
            );
            await rewriteSingleLine(ins.rows[0].id, title, cents, enr.student_id, q);
          }
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
          msg: `Reschedule applied — $${(totalBalanceCents / 100).toFixed(2)} across ${plan.length} new installment(s).`,
        });
      }

      // ── set_tuition_override ─────────────────────────────────────────
      // Sets (or clears) a per-enrollment tuition override.
      //   override_amount = '' or 'clear' → remove override, return to
      //                                     computed grid+plan+addon total
      //   override_amount = '0'           → scholarship: family owes $0,
      //                                     no invoices generated
      //   override_amount = '5000'        → family owes $5,000 total,
      //                                     spread across the plan's
      //                                     installments
      //
      // Implementation: load the existing enrollment's tuition_grid_id +
      // payment_plan_id + addon keys, then re-call the generator with
      // the new override. The generator handles the rest (upsert
      // enrollment, void drafts, regenerate invoices — or skip them for
      // a $0 override).
      case 'set_tuition_override': {
        const amountStr = String(fd.get('override_amount') ?? '').trim().toLowerCase();
        const reason = String(fd.get('override_reason') ?? '').trim() || null;

        const clearing = amountStr === '' || amountStr === 'clear';
        const overrideCents: number | null = clearing
          ? null
          : dollarsToCents(amountStr);

        if (!clearing && overrideCents! < 0) {
          return back(request, fallback, returnTo, { err: 'Override amount cannot be negative.' });
        }

        // Pull the existing enrollment config we need to pass back to
        // the generator so the regen preserves grid/plan/addons.
        const { rows: cfg } = await query<{
          tuition_grid_id: string;
          payment_plan_id: string;
          academic_year: string;
          addons: Array<{ key: string }> | null;
        }>(
          `SELECT tuition_grid_id, payment_plan_id, academic_year, addons
             FROM family_tuition_enrollments WHERE id = $1`,
          [enrollmentId],
        );
        if (cfg.length === 0) {
          return back(request, fallback, returnTo, { err: 'Enrollment not found.' });
        }
        const addonKeys = Array.isArray(cfg[0].addons)
          ? cfg[0].addons.map((a) => a?.key).filter((k): k is string => typeof k === 'string')
          : [];

        await generateTuitionEnrollment({
          schoolId,
          familyId: enr.family_id,
          studentId: enr.student_id,
          academicYear: cfg[0].academic_year,
          tuitionGridId: cfg[0].tuition_grid_id,
          paymentPlanId: cfg[0].payment_plan_id,
          addonKeys,
          createdByEmail: 'operator@growthsuite.local',
          tuitionOverrideCents: overrideCents,
          tuitionOverrideReason: clearing ? null : reason,
        });

        const msg = clearing
          ? 'Override cleared — tuition reverted to the standard amount and invoices regenerated.'
          : overrideCents === 0
            ? `Scholarship applied — family owes $0. ${reason ? `Reason: "${reason}". ` : ''}Existing draft invoices removed.`
            : `Tuition set to $${(overrideCents! / 100).toFixed(2)}. ${reason ? `Reason: "${reason}". ` : ''}Installments regenerated.`;
        return back(request, fallback, returnTo, { msg });
      }

      default:
        return back(request, fallback, returnTo, { err: `Unknown action: ${action}` });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return back(request, fallback, returnTo, { err: `Action failed: ${msg}` });
  }
}
