// POST /api/admin/schools/{schoolId}/payments/invoices
//
// Creates a new invoice with line items, in either 'draft' or 'open'
// status. Open invoices fire an email notification to the parent.
//
// Form fields:
//   family_id          uuid (required)
//   title              text (required)
//   description        text (optional)
//   due_date           YYYY-MM-DD (required)
//   send_now           '1' → status=open + email parent; else draft
//   includes_platform_setup_fee  '1' → adds the $25 fee line and stamps it
//   line_description_<i>, line_quantity_<i>, line_unit_amount_<i>
//                                  (one set per line, 1..N)

import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query, withTransaction } from '@/lib/db';
import { sendInvoiceEmail } from '@/lib/billing/send-invoice-email';
import { evaluateDiscounts, recordDiscountApplications } from '@/lib/billing/discounts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type Params = Promise<{ schoolId: string }>;

const PLATFORM_FEE_CENTS = parseInt(process.env.STRIPE_PLATFORM_FAMILY_SETUP_FEE_CENTS || '2500', 10);

// Validate the school-supplied return path so it can't be used as an
// open-redirect vector. We only accept relative paths under /admin/ or
// /school/ (the school-scoped Payments hub mirror).
function safeReturnPath(returnTo: string | null, defaultHref: string): string {
  if (returnTo && /^\/(admin|school)\/[A-Za-z0-9_-]+(\/[^?#]*)?(\?[^#]*)?$/.test(returnTo)) {
    return returnTo;
  }
  return defaultHref;
}

function back(
  request: NextRequest,
  schoolId: string,
  q: { msg?: string; err?: string; href?: string },
  returnTo: string | null = null,
) {
  const url = request.nextUrl.clone();
  // Priority: explicit q.href (set by some callers below) > returnTo
  // form field (set by /school namespace pages) > /admin default.
  const target = q.href ?? safeReturnPath(returnTo, `/admin/${schoolId}/payments/invoices`);
  // safeReturnPath may include a query string; URL.pathname doesn't
  // accept that. Split it.
  const [path, qs] = target.split('?');
  url.pathname = path;
  url.search = qs ? `?${qs}` : '';
  if (q.msg) url.searchParams.set('msg', q.msg);
  if (q.err) url.searchParams.set('err', q.err);
  return NextResponse.redirect(url, 303);
}

function dollarsToCents(raw: string): number {
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}

interface LineInput {
  description: string;
  quantity: number;
  unit_amount_cents: number;
  amount_cents: number;
  category: string | null;
}

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId } = await params;
  const fd = await request.formData();

  // Where to bounce on success/failure. School-scoped pages send a
  // /school/... path so the operator stays inside the iframe.
  const returnTo = String(fd.get('return_to') ?? '').trim() || null;

  // Recipient: EITHER an existing family OR an arbitrary contact
  // (recipient_email required; name + GHL id optional). The form's
  // recipient_mode tells us which path the operator chose.
  const recipientMode = String(fd.get('recipient_mode') ?? 'family').trim();
  const familyId = recipientMode === 'family'
    ? (String(fd.get('family_id') ?? '').trim() || null)
    : null;
  const recipientName = recipientMode === 'anyone'
    ? (String(fd.get('recipient_name') ?? '').trim() || null) : null;
  const recipientEmailRaw = recipientMode === 'anyone'
    ? String(fd.get('recipient_email') ?? '').trim().toLowerCase() : '';
  const recipientEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmailRaw) ? recipientEmailRaw : null;
  const recipientGhlContactId = recipientMode === 'anyone'
    ? (String(fd.get('recipient_ghl_contact_id') ?? '').trim() || null) : null;

  const title = String(fd.get('title') ?? '').trim();
  const description = String(fd.get('description') ?? '').trim() || null;
  const dueDate = String(fd.get('due_date') ?? '').trim();
  const sendNow = fd.get('send_now') === '1';
  // Setup fee is a family-only concept; never auto-charge a one-off
  // contact for it.
  const includesSetupFee = familyId ? fd.get('includes_platform_setup_fee') === '1' : false;

  if (!familyId && !recipientEmail) {
    return back(request, schoolId, { err: 'Pick a family, or enter a valid recipient email.' }, returnTo);
  }
  if (!title) return back(request, schoolId, { err: 'Title is required.' }, returnTo);
  if (!dueDate) return back(request, schoolId, { err: 'Due date is required.' }, returnTo);

  // Parse line items from indexed form fields.
  const lines: LineInput[] = [];
  for (let i = 0; i < 50; i++) {
    const d = String(fd.get(`line_description_${i}`) ?? '').trim();
    const q = parseInt(String(fd.get(`line_quantity_${i}`) ?? '0'), 10);
    const u = dollarsToCents(String(fd.get(`line_unit_amount_${i}`) ?? '0'));
    const cat = String(fd.get(`line_category_${i}`) ?? '').trim().toLowerCase();
    if (!d || !q || u <= 0) continue;
    lines.push({
      description: d,
      quantity: q,
      unit_amount_cents: u,
      amount_cents: q * u,
      category: cat || null,
    });
  }
  if (lines.length === 0) {
    return back(request, schoolId, { err: 'Add at least one line item with a description and amount.' }, returnTo);
  }

  const subtotalCents = lines.reduce((acc, l) => acc + l.amount_cents, 0);
  const platformFeeCents = includesSetupFee ? PLATFORM_FEE_CENTS : 0;

  // ── DISCOUNTS ────────────────────────────────────────────────────────
  // Evaluate auto-apply policies (sibling, early-bird, FA) and any code
  // the operator typed. Mirror of the parent-portal form-submission flow
  // so manual invoices honor the same per-school discount rules.
  const redemptionCode = String(fd.get('redemption_code') ?? '').trim();
  // Resolve student_id for the family: if exactly one active student,
  // attribute the invoice to them so per-student auto rules (e.g.
  // "applies to a particular child") have the right context. Non-family
  // invoices have no student + no auto-discount evaluation.
  let studentId: string | null = null;
  if (familyId) {
    const { rows: stRows } = await query<{ id: string }>(
      `SELECT id FROM students WHERE family_id = $1 AND status = 'active' ORDER BY first_name LIMIT 2`,
      [familyId],
    );
    if (stRows.length === 1) studentId = stRows[0].id;
  }

  type DiscountEval = Awaited<ReturnType<typeof evaluateDiscounts>>;
  const discountResult: DiscountEval = familyId
    ? await evaluateDiscounts({
        schoolId,
        familyId,
        studentId,
        lines: lines.map((l) => ({
          description: l.description,
          amount_cents: l.amount_cents,
          category: l.category,
        })),
        redemptionCode: redemptionCode || undefined,
      })
    : ({ total_cents: 0, lines: [], applications: [] } as unknown as DiscountEval);
  const discountTotal = discountResult.total_cents;

  // Note: processing fee is computed at parent-pay time (depends on rail).
  // The invoice's processing_fee_cents starts at 0 and gets set when paid.
  const totalCents = Math.max(0, subtotalCents - discountTotal) + platformFeeCents;

  // Get the school's invoice prefix + next number, atomically increment.
  const { rows: configRows } = await query<{ prefix: string; next: number }>(
    `INSERT INTO school_payment_config (school_id) VALUES ($1)
     ON CONFLICT (school_id) DO UPDATE SET next_invoice_number = school_payment_config.next_invoice_number + 1
     RETURNING invoice_number_prefix AS prefix, next_invoice_number AS next`,
    [schoolId],
  );
  // The ON CONFLICT bumps. For the very first invoice we want the initial
  // value (1) and bump to 2 — so we read the row again to get the value
  // BEFORE the increment we just performed.
  const invoiceNumberSeq = configRows[0].next > 1 ? configRows[0].next - 1 : 1;
  const invoiceNumber = `${configRows[0].prefix}-${String(invoiceNumberSeq).padStart(6, '0')}`;

  // Public pay token — lets a non-family recipient pay via /pay/<id>?t=<token>
  // without a portal login. Generated for every invoice (family invoices
  // also gain a usable public link, harmless since amounts are fixed).
  const publicPayToken = randomBytes(18).toString('hex');

  try {
    const newInvoiceId = await withTransaction(async (q) => {
      const insR = await q<{ id: string }>(
        `INSERT INTO invoices
           (school_id, family_id, student_id, invoice_number, title, description,
            status, subtotal_cents, platform_fee_cents, discount_total_cents,
            total_cents, due_at, issued_at, source,
            includes_platform_setup_fee, created_by_email,
            recipient_name, recipient_email, recipient_ghl_contact_id, public_pay_token)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                 'manual', $14, $15, $16, $17, $18, $19)
         RETURNING id`,
        [
          schoolId, familyId, studentId, invoiceNumber, title, description,
          sendNow ? 'open' : 'draft',
          subtotalCents, platformFeeCents, discountTotal, totalCents,
          new Date(dueDate + 'T23:59:59Z').toISOString(),
          sendNow ? new Date().toISOString() : null,
          includesSetupFee,
          'operator@growthsuite.local',
          recipientName, recipientEmail, recipientGhlContactId, publicPayToken,
        ],
      );
      const invoiceId = insR.rows[0].id;

      // Positive line items first.
      let pos = 0;
      for (const l of lines) {
        await q(
          `INSERT INTO invoice_line_items
             (invoice_id, position, description, quantity, unit_amount_cents,
              amount_cents, category, student_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [invoiceId, pos++, l.description, l.quantity, l.unit_amount_cents, l.amount_cents, l.category, studentId],
        );
      }
      // Discount lines (negative amount_cents).
      for (const d of discountResult.lines) {
        await q(
          `INSERT INTO invoice_line_items
             (invoice_id, position, description, quantity, unit_amount_cents,
              amount_cents, category, student_id)
           VALUES ($1, $2, $3, 1, $4, $4, $5, $6)`,
          [invoiceId, pos++, d.description, d.amount_cents, d.category, studentId],
        );
      }
      // Audit rows + bump policy redemption_count. Family-only — a
      // non-family invoice ran no discount evaluation.
      if (familyId) {
        await recordDiscountApplications(
          schoolId, familyId, invoiceId, discountResult.applications, q,
        );
      }
      return invoiceId;
    });

    // Fire the parent email if send_now=1.
    let emailNote = '';
    if (sendNow) {
      try {
        const r = await sendInvoiceEmail({ invoiceId: newInvoiceId });
        emailNote = r.sent_to.length > 0
          ? ` Emailed to ${r.sent_to.length} parent(s).`
          : ' (No email — no parents with email on file.)';
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        emailNote = ` (Email failed: ${m})`;
      }
    }
    const discountNote = discountTotal > 0
      ? ` Auto-applied ${discountResult.lines.length} discount${discountResult.lines.length === 1 ? '' : 's'} ($${(discountTotal / 100).toFixed(2)} off).`
      : redemptionCode
        ? ` (Code "${redemptionCode}" did not match an active policy.)`
        : '';
    // Where to send the operator after successful create:
    //   - If they came from /school/{locationId}/..., land them on the
    //     school-scoped invoice detail (stays in iframe).
    //   - Otherwise, land on the /admin detail (operator namespace).
    const schoolMatch = returnTo ? /^\/school\/([^/]+)\//.exec(returnTo) : null;
    const detailHref = schoolMatch
      ? `/school/${schoolMatch[1]}/payments/invoices/${newInvoiceId}`
      : `/admin/${schoolId}/payments/invoices/${newInvoiceId}`;
    return back(request, schoolId, {
      msg: sendNow
        ? `Invoice ${invoiceNumber} created.${discountNote}${emailNote}`
        : `Invoice ${invoiceNumber} saved as draft.${discountNote}`,
      href: detailHref,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return back(request, schoolId, { err: `Could not create invoice: ${msg}` }, returnTo);
  }
}
