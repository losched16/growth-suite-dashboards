// One-time Growth Suite family setup fee ($25), collected on the family's
// FIRST tuition payment and routed to the PLATFORM account (not the school).
//
// How the money moves: this only stamps `platform_fee_cents` on the invoice.
// Both payment paths in the parent portal already honor it —
// lib/billing/autopay-charge.ts and app/api/billing/create-payment-intent
// charge (subtotal + platform_fee) and pass `application_fee_amount =
// platform_fee_cents` on the connected-account charge, so Stripe splits the
// $25 to the platform and the rest to the school. The portal's pay page shows
// it to the parent as its own line. Nothing else is needed.
//
// Rules:
//   - ONCE PER FAMILY (not per student, not per installment). A family with
//     three kids pays it once.
//   - Lands on the family's EARLIEST UNPAID tuition installment — i.e. the
//     next money they'll actually pay.
//   - Never re-charged: if the family already has a non-voided invoice
//     carrying the fee (paid or not), this is a no-op.
//   - Survives regeneration: Change plan / Edit tuition fees delete + rebuild
//     unpaid invoices, which drops the flag. Calling this at the end of
//     generateTuitionEnrollment re-stamps it — unless the family already PAID
//     it, in which case the paid invoice still carries the flag and we skip.
//
// Off by default for every school. Enable per-school via
// schools.settings.platform_family_fee = { enabled: true, cents: 2500 }.

import { query } from '@/lib/db';

const DEFAULT_FEE_CENTS = 2500;

export interface SetupFeeResult {
  applied: boolean;
  reason?: string;
  invoice_number?: string;
  cents?: number;
}

async function feeCentsFor(schoolId: string): Promise<number> {
  const { rows } = await query<{ cfg: { enabled?: boolean; cents?: number } | null }>(
    `SELECT settings->'platform_family_fee' AS cfg FROM schools WHERE id = $1`,
    [schoolId],
  );
  const cfg = rows[0]?.cfg;
  if (!cfg || typeof cfg !== 'object' || cfg.enabled !== true) return 0;
  const c = typeof cfg.cents === 'number' && Number.isFinite(cfg.cents) && cfg.cents > 0
    ? cfg.cents : DEFAULT_FEE_CENTS;
  return c;
}

export async function applyFamilySetupFee(schoolId: string, familyId: string): Promise<SetupFeeResult> {
  const cents = await feeCentsFor(schoolId);
  if (cents <= 0) return { applied: false, reason: 'not_enabled' };

  // Already carried by any live invoice for this family? Then it's either
  // already paid or already staged — never stamp a second one.
  const { rows: existing } = await query<{ invoice_number: string; status: string }>(
    `SELECT invoice_number, status FROM invoices
      WHERE school_id = $1 AND family_id = $2
        AND includes_platform_setup_fee = true AND status <> 'voided'
      LIMIT 1`,
    [schoolId, familyId],
  );
  if (existing[0]) {
    return { applied: false, reason: `already_on_${existing[0].invoice_number}` };
  }

  // The next money they'll actually pay: earliest-due, untouched tuition
  // installment. Two guards matter here:
  //   - amount_paid_cents = 0 → never alter a part-paid bill.
  //   - no payment row in flight → a `pending`/`processing` charge (ACH sits
  //     there for days) was authorized for the PRE-fee amount, so adding $25
  //     now would never be collected: the invoice still settles at the old
  //     total, and the flag would make us think we'd charged it. Skip to the
  //     next clean installment instead.
  const { rows: target } = await query<{ id: string; invoice_number: string }>(
    `SELECT i.id, i.invoice_number FROM invoices i
      WHERE i.school_id = $1 AND i.family_id = $2
        AND i.source = 'tuition_plan'
        AND i.status IN ('open', 'draft')
        AND i.amount_paid_cents = 0
        AND NOT EXISTS (
          SELECT 1 FROM payments p
           WHERE p.invoice_id = i.id
             AND p.status IN ('pending', 'processing', 'succeeded')
        )
      ORDER BY i.due_at ASC, i.created_at ASC
      LIMIT 1`,
    [schoolId, familyId],
  );
  if (!target[0]) return { applied: false, reason: 'no_unpaid_tuition_invoice' };

  await query(
    `UPDATE invoices
        SET platform_fee_cents = $2, includes_platform_setup_fee = true, updated_at = now()
      WHERE id = $1`,
    [target[0].id, cents],
  );
  return { applied: true, invoice_number: target[0].invoice_number, cents };
}
