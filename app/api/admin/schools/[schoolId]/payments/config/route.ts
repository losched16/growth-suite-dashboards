// POST /api/admin/schools/{schoolId}/payments/config
//
// Upserts the school's billing config row (school_payment_config).

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string }>;

function back(request: NextRequest, schoolId: string, q: { msg?: string; err?: string }) {
  const url = request.nextUrl.clone();
  url.pathname = `/admin/${schoolId}/payments`;
  url.search = '';
  if (q.msg) url.searchParams.set('msg', q.msg);
  if (q.err) url.searchParams.set('err', q.err);
  return NextResponse.redirect(url, 303);
}

function parseDays(raw: string): number[] {
  // "1, 15, 30" → [1, 15, 28] (capped at 28 so every month has the day)
  const out = new Set<number>();
  for (const tok of raw.split(',')) {
    const n = parseInt(tok.trim(), 10);
    if (!Number.isFinite(n) || n < 1) continue;
    out.add(Math.min(n, 28));
  }
  return [...out].sort((a, b) => a - b);
}

function dollarsToCents(raw: string): number {
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId } = await params;
  const fd = await request.formData();

  try {
    const passCard = fd.get('pass_card_fee') === '1';
    const passAch = fd.get('pass_ach_fee') === '1';
    const cardEnabled = fd.get('card_enabled') === '1';
    const achEnabled = fd.get('ach_enabled') === '1';
    const feeLabel = String(fd.get('processing_fee_label') ?? '').trim() || 'Processing fee';
    const days = parseDays(String(fd.get('autopay_days') ?? '1, 15'));
    const lateFeeCents = dollarsToCents(String(fd.get('late_fee_amount') ?? '0'));
    const graceDays = parseInt(String(fd.get('late_fee_grace_days') ?? '3'), 10) || 0;
    const invoicePrefix = String(fd.get('invoice_number_prefix') ?? 'INV').trim().toUpperCase().slice(0, 8) || 'INV';
    // GHL receipt webhook URL — accept only https GHL-ish URLs; blank
    // clears it (back to Resend fallback). We don't hard-require the
    // leadconnector host so other GHL white-label domains still work,
    // but we do require https to avoid pasting a plain-http or junk URL.
    const ghlWebhookRaw = String(fd.get('ghl_receipt_webhook_url') ?? '').trim();
    const ghlWebhookUrl = ghlWebhookRaw && /^https:\/\/[^\s]+$/i.test(ghlWebhookRaw)
      ? ghlWebhookRaw.slice(0, 1000)
      : null;

    await query(
      `INSERT INTO school_payment_config
         (school_id, pass_card_fee, pass_ach_fee, processing_fee_label,
          autopay_days, late_fee_amount_cents, late_fee_grace_days,
          card_enabled, ach_enabled, invoice_number_prefix,
          ghl_receipt_webhook_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (school_id) DO UPDATE SET
         pass_card_fee = EXCLUDED.pass_card_fee,
         pass_ach_fee = EXCLUDED.pass_ach_fee,
         processing_fee_label = EXCLUDED.processing_fee_label,
         autopay_days = EXCLUDED.autopay_days,
         late_fee_amount_cents = EXCLUDED.late_fee_amount_cents,
         late_fee_grace_days = EXCLUDED.late_fee_grace_days,
         card_enabled = EXCLUDED.card_enabled,
         ach_enabled = EXCLUDED.ach_enabled,
         invoice_number_prefix = EXCLUDED.invoice_number_prefix,
         ghl_receipt_webhook_url = EXCLUDED.ghl_receipt_webhook_url,
         updated_at = now()`,
      [schoolId, passCard, passAch, feeLabel, days, lateFeeCents, graceDays,
       cardEnabled, achEnabled, invoicePrefix, ghlWebhookUrl],
    );

    return back(request, schoolId, { msg: 'Billing config saved.' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return back(request, schoolId, { err: `Save failed: ${msg}` });
  }
}
