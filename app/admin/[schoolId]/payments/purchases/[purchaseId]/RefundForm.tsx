'use client';

// Refund form. Operator picks an amount (defaults to full remaining)
// and optional reason. POSTs to /refund endpoint which issues the
// Stripe refund on the school's Connect account, then updates DB.

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw, Loader2 } from 'lucide-react';

export function RefundForm({
  schoolId, purchaseId, maxRefundCents,
}: {
  schoolId: string;
  purchaseId: string;
  maxRefundCents: number;
}) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [amount, setAmount] = useState<string>((maxRefundCents / 100).toFixed(2));
  const [reason, setReason] = useState<string>('requested_by_customer');

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    const cents = Math.round(parseFloat(amount) * 100);
    if (!Number.isFinite(cents) || cents <= 0) {
      setErr('Enter a refund amount.');
      return;
    }
    if (cents > maxRefundCents) {
      setErr(`Amount exceeds remaining refundable ($${(maxRefundCents/100).toFixed(2)}).`);
      return;
    }

    const confirmed = window.confirm(
      `Refund $${(cents / 100).toFixed(2)} to the buyer's original payment method?\n\n`
      + `This will be sent through Stripe immediately and cannot be undone.`,
    );
    if (!confirmed) return;

    startTransition(async () => {
      try {
        const r = await fetch(`/api/admin/schools/${schoolId}/purchases/${purchaseId}/refund`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount_cents: cents, reason }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error((body as { detail?: string }).detail || (body as { error?: string }).error || `HTTP ${r.status}`);
        }
        router.refresh();
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'Refund failed.');
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2">
      {err ? (
        <div className="rounded border border-red-300 bg-red-50 px-2 py-1.5 text-xs text-red-800">{err}</div>
      ) : null}
      <div className="flex items-end gap-2 flex-wrap">
        <label className="block">
          <span className="text-[11px] font-medium text-gray-700">Amount</span>
          <div className="flex items-center gap-1">
            <span className="text-gray-500">$</span>
            <input
              type="number"
              step="0.01"
              min="0.01"
              max={(maxRefundCents / 100).toFixed(2)}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-28 rounded border border-amber-300 bg-white px-2 py-1 text-sm"
            />
          </div>
        </label>
        <label className="block">
          <span className="text-[11px] font-medium text-gray-700">Reason</span>
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="rounded border border-amber-300 bg-white px-2 py-1 text-sm"
          >
            <option value="requested_by_customer">Requested by customer</option>
            <option value="duplicate">Duplicate charge</option>
            <option value="fraudulent">Fraudulent</option>
            <option value="other">Other</option>
          </select>
        </label>
        <button
          type="submit"
          disabled={busy}
          className="inline-flex items-center gap-1 rounded-md bg-amber-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-800 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          Refund
        </button>
      </div>
    </form>
  );
}
